package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"sync"
	"time"

	"github.com/maxbaines/just-terminal/internal/authserver"
	codexintegration "github.com/maxbaines/just-terminal/internal/codex"
	muxcfg "github.com/maxbaines/just-terminal/internal/config"
	"github.com/maxbaines/just-terminal/internal/sessiond"
	"github.com/maxbaines/just-terminal/internal/tunnelorigin"
)

func init() {
	// Go's mime package has no built-in mapping for the PWA manifest
	// extension. Without this, http.FileServer serves manifest.webmanifest as
	// application/octet-stream and some browsers reject it.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// Config holds the configuration for creating a new Server.
type Config struct {
	Addr          string
	Secret        string
	StaticFS      fs.FS
	NoAuth        bool          // skip all auth checks, including loopback bypass (dev only)
	ConfigPath    string        // path to write config.toml on PATCH /api/config (empty = skip writes)
	InitialConfig muxcfg.Config // initial resolved configuration (zero value = package defaults)
	TunnelOrigin  tunnelorigin.Origin

	// AuthServer is nil when the credential store or WebAuthn configuration is
	// unavailable at startup (see cmd/just-terminal's newAuthServer) — then every
	// non-loopback request is denied (fail closed), and /authorize,
	// /token, /auth/login, /auth/callback are not mounted at all.
	AuthServer *authserver.AuthServer
	// WebRedirectURI is the exact-match redirect URI for the just-terminal-web
	// OAuth client (e.g. "http://127.0.0.1:8311/auth/callback").
	WebRedirectURI string
	// BehindReverseProxy mirrors config.ServerConfig.BehindReverseProxy.
	// When true the IsLocalhost() auth bypass is disabled entirely — see
	// internal/server/authmiddleware.go.
	BehindReverseProxy bool
}

// Server is the HTTP server for just-terminal.
type Server struct {
	addr         string
	noAuth       bool
	mux          *http.ServeMux
	hub          *Hub
	tunnels      *TunnelRegistry
	tunnelOrigin tunnelorigin.Origin

	authSrv        *authserver.AuthServer
	webRedirectURI string

	// configPath is the file path for persisting PATCH /api/config writes.
	// Empty string means writes are skipped (dev/test mode).
	configPath string
	cfgMu      sync.RWMutex
	cfg        muxcfg.Config

	// codex owns the managed app-server child and projects its versioned
	// JSON-RPC stream into the stable browser-facing snapshot.
	codex *codexintegration.Manager
}

// New creates a Server, registers routes, and optionally serves static files.
// The Hub is created with a nil dialer; the per-browser daemon dialer is
// injected later via s.hub.SetDialer.
func New(cfg Config) *Server {
	tunnels := NewTunnelRegistry()
	hub := NewHub(nil)

	s := &Server{
		addr:           cfg.Addr,
		noAuth:         cfg.NoAuth,
		mux:            http.NewServeMux(),
		hub:            hub,
		tunnels:        tunnels,
		tunnelOrigin:   cfg.TunnelOrigin,
		authSrv:        cfg.AuthServer,
		webRedirectURI: cfg.WebRedirectURI,
	}

	s.configPath = cfg.ConfigPath
	// Use the supplied initial config if it looks populated (font family is never
	// empty in a real config), otherwise fall back to hardcoded defaults.
	s.cfg = cfg.InitialConfig
	if s.cfg.Font.Family == "" {
		s.cfg = muxcfg.Defaults()
	}

	s.codex = codexintegration.NewManager(
		sessiond.RuntimeDir(),
		sessiond.CodexWorkspaceStatePath(),
		hub.BroadcastCodex,
	)

	authMW := NewAuthMiddleware(cfg.AuthServer, cfg.NoAuth, cfg.BehindReverseProxy)
	protect := func(h http.Handler) http.Handler {
		return authMW.Wrap(h)
	}

	// NOTE for the Phase 2 (MCP-over-HTTP) surface: just-terminal does not yet
	// serve an RFC 8414 .well-known/oauth-authorization-server document, an
	// RFC 9728 .well-known/oauth-protected-resource document, or a POST
	// /mcp route — none of them exist anywhere in this codebase today.
	// When they are added, every absolute URL inside them (issuer,
	// authorization_endpoint, token_endpoint, resource, and the canonical
	// /mcp resource URI) MUST be built from the same origin that produced
	// cfg.WebRedirectURI — cmd/just-terminal's publicBaseURL, which resolves to
	// the operator-configured public_origin behind a reverse proxy and to
	// the loopback derivation otherwise. They MUST NOT be derived from
	// r.Host, X-Forwarded-Host, X-Forwarded-Proto, or any other request
	// header: headers are spoofable, and the design rejects trusting them
	// for any trust-relevant value. Deriving them anywhere else is how
	// these documents silently drift from the registered redirect URI.

	// Public, unauthenticated routes.
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	if s.authSrv != nil {
		s.mux.HandleFunc("GET /authorize", s.authSrv.ServeAuthorize)
		s.mux.HandleFunc("POST /authorize", s.authSrv.ServeAuthorize)
		s.mux.HandleFunc("POST /token", s.authSrv.ServeToken)
		s.mux.HandleFunc("GET /auth/login", s.handleAuthLogin)
		s.mux.HandleFunc("GET /auth/callback", s.handleAuthCallback)
		s.mux.HandleFunc("POST /auth/logout", s.handleAuthLogout)
		s.mux.HandleFunc("GET /auth/setup", s.authSrv.ServeSetupPage)
		s.mux.HandleFunc("POST /auth/setup/unlock", s.authSrv.ServeSetupUnlock)
		s.mux.HandleFunc("POST /auth/setup/passkey/begin", s.authSrv.ServeSetupPasskeyBegin)
		s.mux.HandleFunc("POST /auth/setup/passkey/finish", s.authSrv.ServeSetupPasskeyFinish)
		s.mux.HandleFunc("POST /auth/setup/totp/begin", s.authSrv.ServeSetupTOTPBegin)
		s.mux.HandleFunc("POST /auth/setup/totp/finish", s.authSrv.ServeSetupTOTPFinish)
		s.mux.HandleFunc("POST /auth/passkey/begin", s.authSrv.ServePasskeyBegin)
		s.mux.HandleFunc("POST /auth/passkey/finish", s.authSrv.ServePasskeyFinish)
	}

	// Protected routes: loopback bypass, else a valid session (cookie or
	// bearer token) is required — see internal/server/authmiddleware.go.
	s.mux.Handle("GET /api/config", protect(http.HandlerFunc(s.handleGetConfig)))
	s.mux.Handle("PATCH /api/config", protect(http.HandlerFunc(s.handlePatchConfig)))
	s.mux.Handle("GET /api/files", protect(http.HandlerFunc(s.handleFileRead)))
	s.mux.Handle("GET /api/file-tree", protect(http.HandlerFunc(s.handleFileTree)))
	s.mux.Handle("POST /api/directories", protect(http.HandlerFunc(s.handleDirectoryEnsure)))

	s.mux.Handle("GET /api/codex/status", protect(http.HandlerFunc(s.handleCodexStatus)))
	s.mux.Handle("POST /api/codex/claims", protect(http.HandlerFunc(s.handleCodexClaim)))
	s.mux.Handle("POST /api/codex/acknowledge", protect(http.HandlerFunc(s.handleCodexAcknowledge)))

	s.mux.Handle("GET /api/tunnels", protect(http.HandlerFunc(s.handleTunnelList)))
	s.mux.Handle("POST /api/tunnels", protect(http.HandlerFunc(s.handleTunnelCreate)))
	s.mux.Handle("DELETE /api/tunnels/{id}", protect(http.HandlerFunc(s.handleTunnelClose)))
	s.mux.Handle("GET /ws", protect(http.HandlerFunc(s.handleWS)))

	if cfg.StaticFS != nil {
		s.mux.Handle("/", protect(http.FileServer(http.FS(cfg.StaticFS))))
	}

	return s
}

// Handler returns the http.Handler for use with httptest or custom servers.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.serveHTTP)
}

// ListenAndServe starts the HTTP server and blocks until ctx is cancelled.
// It performs a graceful shutdown with a 5-second timeout and returns nil
// when the server closes normally.
func (s *Server) ListenAndServe(ctx context.Context) error {
	go s.codex.Run(ctx)

	srv := &http.Server{
		Addr:    s.addr,
		Handler: s.Handler(),
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		// Drain the ListenAndServe error (ErrServerClosed)
		<-errCh
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Server) handleCodexStatus(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.codex.Snapshot())
}

func (s *Server) handleCodexClaim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if err := s.codex.Claim(body.WorkspaceID); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{}\n"))
}

// handleCodexAcknowledge accepts the selected default in a managed Codex TUI
// without visibly attaching the browser to that workspace.
func (s *Server) handleCodexAcknowledge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceID string `json:"workspaceId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if !s.codex.IsWaiting(body.WorkspaceID) && !s.codex.HasAssignment(body.WorkspaceID) {
		http.Error(w, "Codex is not waiting in this workspace", http.StatusConflict)
		return
	}
	dc, err := s.hub.Dial()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer dc.Close()
	go func() { _ = dc.Run() }()
	comp, err := dc.Attach(body.WorkspaceID, "", "agent")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	targetPaneID := 0
	for _, pane := range comp.Panes {
		if pane.SurfaceKind != "driver" {
			continue
		}
		targetPaneID = pane.PaneID
		break
	}
	if targetPaneID == 0 {
		for _, pane := range comp.Panes {
			if pane.SurfaceKind == "" || pane.SurfaceKind == "terminal" {
				targetPaneID = pane.PaneID
				break
			}
		}
	}
	if targetPaneID != 0 {
		if err := dc.Input(uint32(targetPaneID), []byte{'\r'}); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}\n"))
		return
	}
	http.Error(w, "Codex terminal pane not found", http.StatusConflict)
}

// Hub returns the server's WebSocket hub.
func (s *Server) Hub() *Hub {
	return s.hub
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.handleWSImpl(w, r)
}

// handleTunnelList returns a JSON array of all active tunnels (id, port).
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleTunnelList(w http.ResponseWriter, r *http.Request) {
	if !s.tunnelOrigin.Configured() {
		http.Error(w, "local apps unavailable: configure tunnel_origin", http.StatusServiceUnavailable)
		return
	}
	entries := s.tunnels.List()
	items := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		items = append(items, map[string]any{
			"id":   e.id,
			"port": e.port,
			"url":  s.tunnelOrigin.AccessURL(e.id, e.token),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items) //nolint:errcheck
}

// handleTunnelCreate registers a new port-forward tunnel and returns the
// assigned id. Body must be JSON {"port": <int>}. AuthMiddleware protects
// this route at mux registration.
func (s *Server) handleTunnelCreate(w http.ResponseWriter, r *http.Request) {
	if !s.tunnelOrigin.Configured() {
		http.Error(w, "local apps unavailable: configure tunnel_origin", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Port int `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "port required", http.StatusBadRequest)
		return
	}
	if body.Port < 1 || body.Port > 65535 {
		http.Error(w, "port must be between 1 and 65535", http.StatusBadRequest)
		return
	}
	id, err := s.tunnels.Create(body.Port)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"id":   id,
		"port": body.Port,
		"url":  s.tunnelOrigin.AccessURL(id, s.tunnels.Token(id)),
	})
}

// handleTunnelClose deregisters the tunnel identified by the {id} path
// segment. Returns 404 when the id is unknown. AuthMiddleware protects this
// route at mux registration.
func (s *Server) handleTunnelClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.tunnels.Close(id) {
		http.Error(w, "tunnel not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
}
