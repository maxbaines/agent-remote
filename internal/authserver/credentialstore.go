package authserver

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	credentialFileVersion = 1
	bootstrapTTL          = 10 * time.Minute
	recoveryCodeCount     = 10
)

var (
	ErrAlreadyConfigured = errors.New("authentication is already configured")
	ErrNotConfigured     = errors.New("authentication is not configured")
	ErrInvalidBootstrap  = errors.New("invalid or expired setup code")
	ErrInvalidRecovery   = errors.New("invalid recovery credentials")
)

// CredentialStore persists Agent Remote's single-owner authentication state.
// The TOTP secret cannot be hashed (verification requires the original
// secret), so the directory and file are restricted to 0700/0600 just like the
// existing opaque OAuth token store.
type CredentialStore struct {
	mu   sync.Mutex
	path string
	data credentialFile
}

type credentialFile struct {
	Version        int                `json:"version"`
	Active         bool               `json:"active"`
	UserID         []byte             `json:"user_id,omitempty"`
	Passkeys       []storedCredential `json:"passkeys,omitempty"`
	TOTPSecret     string             `json:"totp_secret,omitempty"`
	RecoveryHashes []string           `json:"recovery_hashes,omitempty"`
	Bootstrap      *bootstrapRecord   `json:"bootstrap,omitempty"`
}

type bootstrapRecord struct {
	Hash      string    `json:"hash"`
	ExpiresAt time.Time `json:"expires_at"`
}

// storedCredential carries the raw authenticator flag byte separately. The
// upstream CredentialFlags type intentionally keeps that value unexported, so
// ordinary JSON round-tripping would otherwise lose information required to
// faithfully restore a WebAuthn credential record.
type storedCredential struct {
	Credential webauthn.Credential `json:"credential"`
	Flags      byte                `json:"flags"`
}

type ownerUser struct {
	id          []byte
	credentials []webauthn.Credential
}

func (u *ownerUser) WebAuthnID() []byte          { return append([]byte(nil), u.id...) }
func (u *ownerUser) WebAuthnName() string        { return "owner" }
func (u *ownerUser) WebAuthnDisplayName() string { return "Agent Remote owner" }
func (u *ownerUser) WebAuthnCredentials() []webauthn.Credential {
	return append([]webauthn.Credential(nil), u.credentials...)
}

// NewCredentialStore opens <dir>/credentials.json, creating the owner-only
// directory when necessary.
func NewCredentialStore(dir string) (*CredentialStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("credentialstore: mkdir: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("credentialstore: chmod dir: %w", err)
	}

	s := &CredentialStore{path: filepath.Join(dir, "credentials.json")}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return nil, fmt.Errorf("credentialstore: load: %w", err)
	}
	return s, nil
}

// AuthStatus is safe to print from the local CLI and deliberately excludes all
// credential and secret material.
type AuthStatus struct {
	Active            bool
	PasskeyCount      int
	RecoveryRemaining int
	BootstrapPending  bool
	BootstrapExpires  time.Time
}

func (s *CredentialStore) Status() (AuthStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return AuthStatus{}, err
	}
	status := AuthStatus{
		Active:            s.data.Active,
		PasskeyCount:      len(s.data.Passkeys),
		RecoveryRemaining: len(s.data.RecoveryHashes),
	}
	if s.data.Bootstrap != nil && s.data.Bootstrap.ExpiresAt.After(time.Now()) {
		status.BootstrapPending = true
		status.BootstrapExpires = s.data.Bootstrap.ExpiresAt
	}
	return status, nil
}

func (s *CredentialStore) IsActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Active
}

// BeginBootstrap replaces any incomplete setup and returns a single-use code.
// It refuses to touch an active installation; the explicit reset command is
// the only path back to an unconfigured state.
func (s *CredentialStore) BeginBootstrap() (string, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return "", time.Time{}, err
	}
	if s.data.Active {
		return "", time.Time{}, ErrAlreadyConfigured
	}

	userID, err := randomBytes(32)
	if err != nil {
		return "", time.Time{}, err
	}
	codeBytes, err := randomBytes(16)
	if err != nil {
		return "", time.Time{}, err
	}
	code := formatCode(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(codeBytes))
	expires := time.Now().Add(bootstrapTTL).UTC()
	previous := s.data
	s.data = credentialFile{
		Version: credentialFileVersion,
		UserID:  userID,
		Bootstrap: &bootstrapRecord{
			Hash:      digestCode(code),
			ExpiresAt: expires,
		},
	}
	if err := s.saveLocked(); err != nil {
		s.data = previous
		return "", time.Time{}, err
	}
	return code, expires, nil
}

// ConsumeBootstrap reloads from disk so a running Gateway observes a setup
// code created by a separate `agent-remote auth init` process.
func (s *CredentialStore) ConsumeBootstrap(code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return err
	}
	record := s.data.Bootstrap
	if s.data.Active || record == nil || !record.ExpiresAt.After(time.Now()) || !sameDigest(record.Hash, digestCode(code)) {
		return ErrInvalidBootstrap
	}
	s.data.Bootstrap = nil
	if err := s.saveLocked(); err != nil {
		s.data.Bootstrap = record
		return err
	}
	return nil
}

func (s *CredentialStore) User() (*ownerUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data.UserID) == 0 {
		return nil, ErrNotConfigured
	}
	return s.userLocked(), nil
}

func (s *CredentialStore) userLocked() *ownerUser {
	credentials := make([]webauthn.Credential, 0, len(s.data.Passkeys))
	for _, stored := range s.data.Passkeys {
		credential := stored.Credential
		credential.Flags = webauthn.NewCredentialFlags(protocol.AuthenticatorFlags(stored.Flags))
		credentials = append(credentials, credential)
	}
	return &ownerUser{id: append([]byte(nil), s.data.UserID...), credentials: credentials}
}

func (s *CredentialStore) AddPasskey(credential webauthn.Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.data.Passkeys {
		if subtle.ConstantTimeCompare(existing.Credential.ID, credential.ID) == 1 {
			return errors.New("passkey is already registered")
		}
	}
	s.data.Passkeys = append(s.data.Passkeys, storeCredential(credential))
	if err := s.saveLocked(); err != nil {
		s.data.Passkeys = s.data.Passkeys[:len(s.data.Passkeys)-1]
		return err
	}
	return nil
}

// UpdatePasskey persists signature counter and backup-state changes returned by
// a successful WebAuthn assertion.
func (s *CredentialStore) UpdatePasskey(credential webauthn.Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Passkeys {
		if subtle.ConstantTimeCompare(s.data.Passkeys[i].Credential.ID, credential.ID) == 1 {
			previous := s.data.Passkeys[i]
			s.data.Passkeys[i] = storeCredential(credential)
			if err := s.saveLocked(); err != nil {
				s.data.Passkeys[i] = previous
				return err
			}
			return nil
		}
	}
	return errors.New("validated passkey is not registered")
}

func storeCredential(credential webauthn.Credential) storedCredential {
	flags := protocol.AuthenticatorFlags(0)
	if credential.Flags.UserPresent {
		flags |= protocol.FlagUserPresent
	}
	if credential.Flags.UserVerified {
		flags |= protocol.FlagUserVerified
	}
	if credential.Flags.BackupEligible {
		flags |= protocol.FlagBackupEligible
	}
	if credential.Flags.BackupState {
		flags |= protocol.FlagBackupState
	}
	return storedCredential{Credential: credential, Flags: byte(flags)}
}

func (s *CredentialStore) BeginTOTP(accountName string) (*otp.Key, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Agent Remote",
		AccountName: accountName,
	})
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.data.TOTPSecret
	s.data.TOTPSecret = key.Secret()
	if err := s.saveLocked(); err != nil {
		s.data.TOTPSecret = previous
		return nil, err
	}
	return key, nil
}

// Activate verifies the freshly enrolled TOTP and atomically makes the auth
// store active while creating one-use recovery codes. The plaintext codes are
// returned exactly once; only their high-entropy SHA-256 digests are persisted.
func (s *CredentialStore) Activate(passcode string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Active {
		return nil, ErrAlreadyConfigured
	}
	if len(s.data.Passkeys) == 0 || s.data.TOTPSecret == "" || !validTOTP(passcode, s.data.TOTPSecret) {
		return nil, errors.New("passkey and a valid authenticator code are required")
	}

	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for range recoveryCodeCount {
		raw, err := randomBytes(10)
		if err != nil {
			return nil, err
		}
		code := formatCode(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw))
		codes = append(codes, code)
		hashes = append(hashes, digestCode(code))
	}
	previousActive := s.data.Active
	previousHashes := s.data.RecoveryHashes
	previousBootstrap := s.data.Bootstrap
	s.data.Active = true
	s.data.RecoveryHashes = hashes
	s.data.Bootstrap = nil
	if err := s.saveLocked(); err != nil {
		s.data.Active = previousActive
		s.data.RecoveryHashes = previousHashes
		s.data.Bootstrap = previousBootstrap
		return nil, err
	}
	return codes, nil
}

// ConsumeRecovery requires both a current TOTP and an unused recovery code,
// then removes that recovery code in the same critical section as validation.
func (s *CredentialStore) ConsumeRecovery(passcode, recoveryCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.data.Active || !validTOTP(passcode, s.data.TOTPSecret) {
		return ErrInvalidRecovery
	}
	want := digestCode(recoveryCode)
	for i, hash := range s.data.RecoveryHashes {
		if sameDigest(hash, want) {
			previous := s.data.RecoveryHashes
			remaining := make([]string, 0, len(previous)-1)
			remaining = append(remaining, previous[:i]...)
			remaining = append(remaining, previous[i+1:]...)
			s.data.RecoveryHashes = remaining
			if err := s.saveLocked(); err != nil {
				s.data.RecoveryHashes = previous
				return err
			}
			return nil
		}
	}
	return ErrInvalidRecovery
}

func validTOTP(passcode, secret string) bool {
	valid, err := totp.ValidateCustom(strings.TrimSpace(passcode), secret, time.Now().UTC(), totp.ValidateOpts{
		Period:    30,
		Skew:      1,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	return err == nil && valid
}

func (s *CredentialStore) loadLocked() error {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		s.data = credentialFile{Version: credentialFileVersion}
		return nil
	}
	if err != nil {
		return err
	}
	var file credentialFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("invalid credential file: %w", err)
	}
	if file.Version != credentialFileVersion {
		return fmt.Errorf("unsupported credential file version %d", file.Version)
	}
	s.data = file
	return nil
}

func (s *CredentialStore) saveLocked() error {
	s.data.Version = credentialFileVersion
	data, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ResetAuthFiles removes only authentication-owned files. Callers should stop
// or restart the Gateway afterward because a running OAuth manager may still
// hold previously loaded access tokens in memory.
func ResetAuthFiles(dir string) error {
	for _, name := range []string{"credentials.json", "credentials.json.tmp", "tokens.json", "tokens.json.tmp"} {
		err := os.Remove(filepath.Join(dir, name))
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", name, err)
		}
	}
	return nil
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func digestCode(code string) string {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

func sameDigest(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func formatCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	var out strings.Builder
	for i, r := range code {
		if i > 0 && i%4 == 0 {
			out.WriteByte('-')
		}
		out.WriteRune(r)
	}
	return out.String()
}
