package authserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/manage"
	oaserver "github.com/go-oauth2/oauth2/v4/server"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// AccessTokenTTL is the deliberate, documented deviation from the MCP
// spec's SHOULD-level short-lived-token recommendation. See design doc,
// internal/authserver section, for the rationale (single-account personal
// tool; periodic re-login is cheap).
const AccessTokenTTL = 30 * 24 * time.Hour

// AuthorizeCodeTTL is the lifetime of the one-time authorization code (not
// the access token). 10 minutes is generous for a human completing a passkey
// ceremony or recovery flow.
const AuthorizeCodeTTL = 10 * time.Minute

// Config configures a new AuthServer.
type Config struct {
	// WebRedirectURI is the exact-match redirect URI for the just-terminal-web
	// client. In direct/local-dev mode it is loopback-derived (e.g.
	// "http://127.0.0.1:8311/auth/callback"); when the operator sets
	// behind_reverse_proxy it is "<public_origin>/auth/callback". Both are
	// produced by cmd/just-terminal's webRedirectURIFor, which is the single
	// derivation seam — this package never derives it, and never inspects
	// a request header to guess it.
	WebRedirectURI string
	// PublicOrigin is the exact browser origin used for WebAuthn origin
	// validation, e.g. https://my-instance.js.actor or
	// http://127.0.0.1:8311 in direct local mode.
	PublicOrigin string
	// CredentialStore holds the single owner's passkeys, TOTP secret, recovery
	// code hashes, and setup bootstrap record. Required.
	CredentialStore *CredentialStore
	// TokenStoreDir is the directory the file-backed token store persists
	// into (owner-only permissions — see tokenstore.go).
	TokenStoreDir string
	// RateLimiter gates repeated failed login attempts. Required.
	RateLimiter *RateLimiter
}

// AuthServer wraps go-oauth2/oauth2 with just-terminal's hardening
// configuration, hardcoded clients, file-backed token store, and
// passkey/TOTP-backed login and setup surfaces.
type AuthServer struct {
	manager       *manage.Manager
	srv           *oaserver.Server
	store         *CredentialStore
	webAuthn      *webauthn.WebAuthn
	limiter       *RateLimiter
	tmpl          *template.Template
	origin        string
	secureCookies bool

	flowMu        sync.Mutex
	ceremonies    map[string]webAuthnCeremony
	setupSessions map[string]time.Time
	loginProofs   map[string]time.Time
}

// New wires a Manager (PKCE S256-only, authorization-code-grant-only, no
// refresh tokens, 30-day access-token TTL) with the hardcoded ClientStore,
// the file-backed TokenStore, and the loopback-port-wildcard redirect URI
// exception bounded to just-terminal-mcp.
func New(cfg Config) (*AuthServer, error) {
	if cfg.CredentialStore == nil {
		return nil, errors.New("authserver: CredentialStore is required")
	}
	if cfg.RateLimiter == nil {
		return nil, errors.New("authserver: RateLimiter is required")
	}
	origin, err := url.Parse(cfg.PublicOrigin)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.Path != "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" {
		return nil, fmt.Errorf("authserver: PublicOrigin %q must be an http(s) origin without a path", cfg.PublicOrigin)
	}
	if origin.Scheme != "https" && !isLocalWebAuthnHost(origin.Hostname()) {
		return nil, fmt.Errorf("authserver: PublicOrigin %q must use https outside localhost", cfg.PublicOrigin)
	}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:                  origin.Hostname(),
		RPDisplayName:         "JustTerminal",
		RPOrigins:             []string{cfg.PublicOrigin},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: 2 * time.Minute},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: 2 * time.Minute},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("authserver: WebAuthn config: %w", err)
	}

	manager := manage.NewDefaultManager()
	manager.SetAuthorizeCodeExp(AuthorizeCodeTTL)
	manager.SetAuthorizeCodeTokenCfg(&manage.Config{
		AccessTokenExp:    AccessTokenTTL,
		IsGenerateRefresh: false, // no refresh tokens, ever — see design doc
	})
	manager.SetValidateURIHandler(validateRedirectURI)

	tokenStore, err := NewFileTokenStore(cfg.TokenStoreDir)
	if err != nil {
		return nil, fmt.Errorf("authserver: token store: %w", err)
	}
	manager.MapTokenStorage(tokenStore)
	manager.MapClientStorage(NewClientStore(cfg.WebRedirectURI))

	srvCfg := &oaserver.Config{
		TokenType:                   "Bearer",
		AllowedResponseTypes:        []oauth2.ResponseType{oauth2.Code},
		AllowedGrantTypes:           []oauth2.GrantType{oauth2.AuthorizationCode},
		AllowedCodeChallengeMethods: []oauth2.CodeChallengeMethod{oauth2.CodeChallengeS256},
		ForcePKCE:                   true,
	}
	srv := oaserver.NewServer(srvCfg, manager)
	srv.SetClientInfoHandler(oaserver.ClientFormHandler)

	as := &AuthServer{
		manager:       manager,
		srv:           srv,
		store:         cfg.CredentialStore,
		webAuthn:      wa,
		limiter:       cfg.RateLimiter,
		tmpl:          template.Must(template.New("login").Parse(loginPageHTML)),
		origin:        cfg.PublicOrigin,
		secureCookies: origin.Scheme == "https",
		ceremonies:    make(map[string]webAuthnCeremony),
		setupSessions: make(map[string]time.Time),
		loginProofs:   make(map[string]time.Time),
	}
	srv.SetUserAuthorizationHandler(as.userAuthorizationHandler)
	return as, nil
}

// Manager exposes the underlying oauth2 Manager so internal/server's auth
// middleware can validate bearer tokens/cookies via LoadAccessToken.
func (a *AuthServer) Manager() *manage.Manager { return a.manager }

// RevokeAccessToken deletes token from the store, ending that session
// immediately rather than waiting out its 30-day TTL. Returns a non-nil
// error if the underlying store operation fails — callers MUST NOT treat
// the token as revoked, and MUST NOT clear any client-side cookie, unless
// this returns nil. See design doc Data Flow "Logout": revocation is
// deletion, and a failed deletion must never be reported as success.
func (a *AuthServer) RevokeAccessToken(ctx context.Context, token string) error {
	return a.manager.RemoveAccessToken(ctx, token)
}

// ServeAuthorize handles GET/POST /authorize.
func (a *AuthServer) ServeAuthorize(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	}
	if err := a.srv.HandleAuthorizeRequest(w, r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	}
}

// ServeToken handles POST /token.
func (a *AuthServer) ServeToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := a.srv.HandleTokenRequest(w, r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
	}
}

// ExchangeAuthorizationCode performs the code-for-token exchange
// in-process (no network round trip — same binary, same process, per
// design doc Data Flow step 6).
func (a *AuthServer) ExchangeAuthorizationCode(clientID, code, verifier, redirectURI string) (accessToken string, expiresIn time.Duration, err error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	}
	req := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	if err := a.srv.HandleTokenRequest(rec, req); err != nil {
		return "", 0, err
	}
	if rec.Code != http.StatusOK {
		return "", 0, fmt.Errorf("authserver: token exchange failed: %s", rec.Body.String())
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		return "", 0, fmt.Errorf("authserver: decode token response: %w", err)
	}
	return body.AccessToken, time.Duration(body.ExpiresIn) * time.Second, nil
}

func (a *AuthServer) userAuthorizationHandler(w http.ResponseWriter, r *http.Request) (string, error) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return "", nil
	}

	if r.Method == http.MethodGet {
		a.renderLoginPage(w, r, "")
		return "", nil
	}
	if !a.store.IsActive() {
		a.renderLoginPage(w, r, "Authentication has not been set up on this host.")
		return "", nil
	}

	ip := clientIP(r)
	if !a.limiter.Reserve(ip) {
		a.renderLoginPage(w, r, "Too many failed attempts. Try again later.")
		return "", nil
	}

	var authenticated bool
	switch r.FormValue("method") {
	case "passkey":
		authenticated = a.consumeLoginProof(w, r)
	case "recovery":
		authenticated = a.store.ConsumeRecovery(r.FormValue("totp"), r.FormValue("recovery_code")) == nil
	}
	if !authenticated {
		// Reserve(ip) already recorded this attempt as a failure atomically.
		a.renderLoginPage(w, r, "Authentication failed.")
		return "", nil
	}
	a.limiter.RecordSuccess(ip)

	// Single-owner system: the opaque OAuth subject is fixed and never comes
	// from browser-controlled display data.
	return "owner", nil
}

var hiddenFieldNames = []string{
	"response_type", "client_id", "redirect_uri", "state",
	"code_challenge", "code_challenge_method", "scope",
}

type loginPageData struct {
	Error  string
	Hidden map[string]string
	Active bool
}

func (a *AuthServer) renderLoginPage(w http.ResponseWriter, r *http.Request, errMsg string) {
	hidden := make(map[string]string, len(hiddenFieldNames))
	for _, name := range hiddenFieldNames {
		hidden[name] = r.FormValue(name)
	}
	setAuthPageHeaders(w)
	if errMsg != "" {
		w.WriteHeader(http.StatusUnauthorized)
	}
	_ = a.tmpl.Execute(w, loginPageData{Error: errMsg, Hidden: hidden, Active: a.store.IsActive()})
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isLocalWebAuthnHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
