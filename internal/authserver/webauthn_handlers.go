package authserver

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"net/url"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	webAuthnCookieName = "agent-remote_webauthn"
	setupCookieName    = "agent-remote_setup"
	loginProofCookie   = "agent-remote_login_proof"
	setupSessionTTL    = 15 * time.Minute
	loginProofTTL      = 2 * time.Minute
	maxCeremonies      = 256
)

type webAuthnCeremony struct {
	Kind      string
	Session   webauthn.SessionData
	ExpiresAt time.Time
}

func (a *AuthServer) ServeSetupPage(w http.ResponseWriter, r *http.Request) {
	setAuthPageHeaders(w)

	if a.store.IsActive() {
		_, _ = w.Write([]byte(setupCompletePageHTML))
		return
	}
	if a.hasSetupSession(r) {
		_, _ = w.Write([]byte(setupEnrollmentPageHTML))
		return
	}
	_, _ = w.Write([]byte(setupUnlockPageHTML))
}

func (a *AuthServer) ServeSetupUnlock(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ip := clientIP(r)
	if !a.limiter.Reserve(ip) {
		http.Error(w, "too many failed attempts; try again later", http.StatusTooManyRequests)
		return
	}
	if err := a.store.ConsumeBootstrap(r.FormValue("code")); err != nil {
		http.Error(w, "invalid or expired setup code", http.StatusUnauthorized)
		return
	}
	a.limiter.RecordSuccess(ip)

	token, err := randomToken(32)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	a.flowMu.Lock()
	a.pruneFlowsLocked()
	a.setupSessions[token] = time.Now().Add(setupSessionTTL)
	a.flowMu.Unlock()
	a.setCookie(w, setupCookieName, token, "/auth/setup", setupSessionTTL)
	http.Redirect(w, r, "/auth/setup", http.StatusSeeOther)
}

func (a *AuthServer) ServeSetupPasskeyBegin(w http.ResponseWriter, r *http.Request) {
	if !a.requireSetupSession(w, r) {
		return
	}
	user, err := a.store.User()
	if err != nil {
		writeJSONError(w, "setup has not been initialized", http.StatusConflict)
		return
	}
	creation, session, err := a.webAuthn.BeginRegistration(
		user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
	)
	if err != nil {
		writeJSONError(w, "could not start passkey registration", http.StatusInternalServerError)
		return
	}
	if err := a.saveCeremony(w, "setup-register", *session); err != nil {
		writeJSONError(w, "could not save passkey registration challenge", http.StatusInternalServerError)
		return
	}
	writeJSON(w, creation)
}

func (a *AuthServer) ServeSetupPasskeyFinish(w http.ResponseWriter, r *http.Request) {
	if !a.requireSetupSession(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	ceremony, ok := a.consumeCeremony(w, r, "setup-register")
	if !ok {
		writeJSONError(w, "passkey registration expired; try again", http.StatusBadRequest)
		return
	}
	user, err := a.store.User()
	if err != nil {
		writeJSONError(w, "setup has not been initialized", http.StatusConflict)
		return
	}
	credential, err := a.webAuthn.FinishRegistration(user, ceremony.Session, r)
	if err != nil {
		writeJSONError(w, "passkey registration could not be verified", http.StatusUnauthorized)
		return
	}
	if err := a.store.AddPasskey(*credential); err != nil {
		writeJSONError(w, "could not save passkey", http.StatusConflict)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *AuthServer) ServeSetupTOTPBegin(w http.ResponseWriter, r *http.Request) {
	if !a.requireSetupSession(w, r) {
		return
	}
	status, err := a.store.Status()
	if err != nil || status.PasskeyCount == 0 {
		writeJSONError(w, "register a passkey first", http.StatusConflict)
		return
	}
	host := "owner"
	if origin, err := url.Parse(a.origin); err == nil && origin.Hostname() != "" {
		host = "owner@" + origin.Hostname()
	}
	key, err := a.store.BeginTOTP(host)
	if err != nil {
		writeJSONError(w, "could not create authenticator secret", http.StatusInternalServerError)
		return
	}
	image, err := key.Image(256, 256)
	if err != nil {
		writeJSONError(w, "could not create authenticator QR code", http.StatusInternalServerError)
		return
	}
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image); err != nil {
		writeJSONError(w, "could not encode authenticator QR code", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{
		"secret": key.Secret(),
		"qr":     "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes()),
	})
}

func (a *AuthServer) ServeSetupTOTPFinish(w http.ResponseWriter, r *http.Request) {
	if !a.requireSetupSession(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, "invalid request", http.StatusBadRequest)
		return
	}
	ip := clientIP(r)
	if !a.limiter.Reserve(ip) {
		writeJSONError(w, "too many failed attempts; try again later", http.StatusTooManyRequests)
		return
	}
	codes, err := a.store.Activate(body.Code)
	if err != nil {
		writeJSONError(w, "authenticator code was not accepted", http.StatusUnauthorized)
		return
	}
	a.limiter.RecordSuccess(ip)
	a.clearSetupSession(w, r)
	writeJSON(w, map[string]any{"ok": true, "recoveryCodes": codes})
}

func (a *AuthServer) ServePasskeyBegin(w http.ResponseWriter, _ *http.Request) {
	if !a.store.IsActive() {
		writeJSONError(w, "authentication is not configured", http.StatusConflict)
		return
	}
	user, err := a.store.User()
	if err != nil {
		writeJSONError(w, "authentication is unavailable", http.StatusServiceUnavailable)
		return
	}
	assertion, session, err := a.webAuthn.BeginLogin(user, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		writeJSONError(w, "could not start passkey authentication", http.StatusInternalServerError)
		return
	}
	if err := a.saveCeremony(w, "login", *session); err != nil {
		writeJSONError(w, "could not save passkey authentication challenge", http.StatusInternalServerError)
		return
	}
	writeJSON(w, assertion)
}

func (a *AuthServer) ServePasskeyFinish(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	ceremony, ok := a.consumeCeremony(w, r, "login")
	if !ok {
		writeJSONError(w, "passkey authentication expired; try again", http.StatusBadRequest)
		return
	}
	user, err := a.store.User()
	if err != nil || !a.store.IsActive() {
		writeJSONError(w, "authentication is unavailable", http.StatusServiceUnavailable)
		return
	}
	credential, err := a.webAuthn.FinishLogin(user, ceremony.Session, r)
	if err != nil {
		writeJSONError(w, "passkey authentication failed", http.StatusUnauthorized)
		return
	}
	if err := a.store.UpdatePasskey(*credential); err != nil {
		writeJSONError(w, "could not update passkey", http.StatusInternalServerError)
		return
	}

	proof, err := randomToken(32)
	if err != nil {
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}
	a.flowMu.Lock()
	a.pruneFlowsLocked()
	a.loginProofs[proof] = time.Now().Add(loginProofTTL)
	a.flowMu.Unlock()
	a.setCookie(w, loginProofCookie, proof, "/authorize", loginProofTTL)
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *AuthServer) saveCeremony(w http.ResponseWriter, kind string, session webauthn.SessionData) error {
	token, err := randomToken(32)
	if err != nil {
		return err
	}
	expires := session.Expires
	if expires.IsZero() {
		expires = time.Now().Add(2 * time.Minute)
	}
	a.flowMu.Lock()
	a.pruneFlowsLocked()
	if len(a.ceremonies) >= maxCeremonies {
		a.flowMu.Unlock()
		return fmt.Errorf("too many active WebAuthn ceremonies")
	}
	a.ceremonies[token] = webAuthnCeremony{Kind: kind, Session: session, ExpiresAt: expires}
	a.flowMu.Unlock()
	a.setCookie(w, webAuthnCookieName, token, "/auth/", time.Until(expires))
	return nil
}

func (a *AuthServer) consumeCeremony(w http.ResponseWriter, r *http.Request, kind string) (webAuthnCeremony, bool) {
	cookie, err := r.Cookie(webAuthnCookieName)
	if err != nil || cookie.Value == "" {
		return webAuthnCeremony{}, false
	}
	a.clearCookie(w, webAuthnCookieName, "/auth/")
	a.flowMu.Lock()
	defer a.flowMu.Unlock()
	a.pruneFlowsLocked()
	ceremony, ok := a.ceremonies[cookie.Value]
	delete(a.ceremonies, cookie.Value)
	return ceremony, ok && ceremony.Kind == kind && ceremony.ExpiresAt.After(time.Now())
}

func (a *AuthServer) hasSetupSession(r *http.Request) bool {
	cookie, err := r.Cookie(setupCookieName)
	if err != nil || cookie.Value == "" {
		return false
	}
	a.flowMu.Lock()
	defer a.flowMu.Unlock()
	a.pruneFlowsLocked()
	expires, ok := a.setupSessions[cookie.Value]
	return ok && expires.After(time.Now())
}

func (a *AuthServer) requireSetupSession(w http.ResponseWriter, r *http.Request) bool {
	if a.hasSetupSession(r) && !a.store.IsActive() {
		return true
	}
	writeJSONError(w, "setup session is missing or expired", http.StatusUnauthorized)
	return false
}

func (a *AuthServer) clearSetupSession(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(setupCookieName); err == nil {
		a.flowMu.Lock()
		delete(a.setupSessions, cookie.Value)
		a.flowMu.Unlock()
	}
	a.clearCookie(w, setupCookieName, "/auth/setup")
}

func (a *AuthServer) consumeLoginProof(w http.ResponseWriter, r *http.Request) bool {
	cookie, err := r.Cookie(loginProofCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	a.clearCookie(w, loginProofCookie, "/authorize")
	a.flowMu.Lock()
	defer a.flowMu.Unlock()
	a.pruneFlowsLocked()
	expires, ok := a.loginProofs[cookie.Value]
	delete(a.loginProofs, cookie.Value)
	return ok && expires.After(time.Now())
}

func (a *AuthServer) pruneFlowsLocked() {
	now := time.Now()
	for token, ceremony := range a.ceremonies {
		if !ceremony.ExpiresAt.After(now) {
			delete(a.ceremonies, token)
		}
	}
	for token, expires := range a.setupSessions {
		if !expires.After(now) {
			delete(a.setupSessions, token)
		}
	}
	for token, expires := range a.loginProofs {
		if !expires.After(now) {
			delete(a.loginProofs, token)
		}
	}
}

func (a *AuthServer) setCookie(w http.ResponseWriter, name, value, path string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		HttpOnly: true,
		Secure:   a.secureCookies,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   max(1, int(ttl.Seconds())),
	})
}

func (a *AuthServer) clearCookie(w http.ResponseWriter, name, path string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		HttpOnly: true,
		Secure:   a.secureCookies,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func randomToken(n int) (string, error) {
	b, err := randomBytes(n)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func setAuthPageHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}
