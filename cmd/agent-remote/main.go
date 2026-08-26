package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/maxbaines/agent-remote/internal/authserver"
	"github.com/maxbaines/agent-remote/internal/config"
	"github.com/maxbaines/agent-remote/internal/deploy"
	"github.com/maxbaines/agent-remote/internal/mcp"
	"github.com/maxbaines/agent-remote/internal/server"
	"github.com/maxbaines/agent-remote/internal/service"
	"github.com/maxbaines/agent-remote/internal/sessiond"
	webstatic "github.com/maxbaines/agent-remote/web"
)

var version = "dev"

func main() {
	cfg, err := ParseArgs(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cfg.Mode {
	case "help":
		printUsage(os.Stdout)
	case "local":
		if err := runLocal(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "serve":
		if err := runServe(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "sessiond":
		if err := runSessiond(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "deploy":
		if err := runDeploy(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "install":
		if err := runInstall(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := runUninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "doctor":
		if err := runDoctor(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "mcp":
		if err := runMCPCommand(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "auth":
		if err := runAuthCommand(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "amplifier-install":
		if err := runAmplifierBundleInstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Printf("Agent Remote %s (MCP: stdio)\n", version)
	}
}

// runDoctor reports the status of the agent-remote daemon and system service.
func runDoctor() error {
	const (
		ok   = "\u2713" // ✓
		fail = "\u2717" // ✗
	)

	fmt.Printf("Agent Remote %s\n\n", version)

	// Daemon
	sock, err := sessiond.SocketPath()
	if err != nil {
		fmt.Printf("  %s  daemon:  could not determine socket path: %v\n", fail, err)
	} else {
		fmt.Printf("     socket:  %s\n", sock)
		if _, err := os.Stat(sock); os.IsNotExist(err) {
			fmt.Printf("  %s  daemon:  not running (socket not found)\n", fail)
			fmt.Printf("     hint:    start with 'agent-remote' or check service logs\n")
		} else {
			c, dialErr := sessiond.Dial(sock)
			if dialErr != nil {
				fmt.Printf("  %s  daemon:  socket exists but connection failed: %v\n", fail, dialErr)
			} else {
				c.Close() //nolint:errcheck
				fmt.Printf("  %s  daemon:  running\n", ok)
			}
		}
	}

	// Log
	if logPath, err := sessiond.DefaultLogPath(); err == nil {
		if _, err := os.Stat(logPath); err == nil {
			fmt.Printf("     log:     %s\n", logPath)
		}
	}

	// Service
	fmt.Println()
	switch runtime.GOOS {
	case "darwin":
		plistPath := service.LaunchdPlistPath()
		if _, err := os.Stat(plistPath); err == nil {
			fmt.Printf("  %s  service: launchd agent installed\n", ok)
			fmt.Printf("     plist:   %s\n", plistPath)
		} else {
			fmt.Printf("  %s  service: not installed\n", fail)
			fmt.Printf("     hint:    run 'agent-remote install' to auto-start on login\n")
		}
	default:
		unitPath := service.SystemdUnitPath()
		if _, err := os.Stat(unitPath); err == nil {
			fmt.Printf("  %s  service: systemd unit installed\n", ok)
			fmt.Printf("     unit:    %s\n", unitPath)
		} else {
			fmt.Printf("  %s  service: not installed\n", fail)
			fmt.Printf("     hint:    run 'agent-remote install' to auto-start on login\n")
		}
	}

	return nil
}

// newSessiondDialerForSocket returns a DialFunc that dials the sessiond daemon
// at socketPath. It does NOT ensure a daemon is running, which makes it a pure,
// unit-testable seam: point it at any live Unix socket and it returns a
// connection-scoped client. serve/local use newSessiondDialer (which also
// ensures the daemon); this variant exists for tests.
func newSessiondDialerForSocket(socketPath string) server.DialFunc {
	return func() (server.DaemonConn, error) {
		return sessiond.Dial(socketPath)
	}
}

// newSessiondDialer returns the DialFunc used by serve/local. Each call ensures
// the sessiond daemon is reachable (Phase 2 helpers: SocketPath + DefaultLogPath
// + EnsureDaemon, a no-op under systemd) and then dials a fresh per-browser
// sessiond.Client. The hub invokes this once per browser WebSocket.
func newSessiondDialer() server.DialFunc {
	return func() (server.DaemonConn, error) {
		sock, err := sessiond.SocketPath()
		if err != nil {
			return nil, err
		}
		logPath, err := sessiond.DefaultLogPath()
		if err != nil {
			return nil, err
		}
		if err := sessiond.EnsureDaemon(sock, logPath); err != nil {
			return nil, err
		}
		return sessiond.Dial(sock)
	}
}

// resolveServerConfig merges the serve-mode CLI overrides on top of the
// config file's [server] section, following this repo's existing
// precedence (flag beats file, file beats the zero default). Consistent
// with config.Merge's documented bool limitation, --behind-reverse-proxy
// cannot be used to turn a config-file `behind_reverse_proxy = true` back
// off; remove the file value instead.
//
// SERVE MODE ONLY. runLocal deliberately does NOT call this: bare
// `agent-remote` is loopback-only by definition and must stay that way even on
// a host whose config.toml sets behind_reverse_proxy = true (which is
// exactly the production host). Honoring the file there would disable the
// loopback bypass and point the local browser at the public origin,
// breaking local interactive use on the one machine where it matters most.
func resolveServerConfig(cli Config, file config.ServerConfig) config.ServerConfig {
	out := file
	if cli.PublicOrigin != "" {
		out.PublicOrigin = cli.PublicOrigin
	}
	if cli.BehindReverseProxy {
		out.BehindReverseProxy = true
	}
	return out
}

// publicBaseURL returns the origin agent-remote must use whenever it constructs
// one of its own public-facing absolute URLs. Today that is the agent-remote-web
// OAuth redirect URI; when Phase 2 (MCP-over-HTTP) adds the RFC 8414
// authorization-server metadata and the RFC 9728 protected-resource
// metadata / canonical /mcp resource URI, those MUST derive from this same
// function so the values cannot drift apart.
//
// Behind a reverse proxy the origin is the operator-configured
// public_origin: a fixed value resolved once at startup, never derived
// per-request from a Host or X-Forwarded-* header — headers are spoofable
// and the design rejects trusting them for any trust-relevant value.
//
// Otherwise it is the pre-existing loopback derivation from addr (the
// server's listen address), where a "0.0.0.0" or unparseable host is
// normalized to 127.0.0.1 because the browser reaches agent-remote over
// loopback in that topology.
func publicBaseURL(addr string, sc config.ServerConfig) string {
	if sc.BehindReverseProxy {
		return sc.BaseURL()
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// webRedirectURIFor returns the exact-match redirect URI for the
// agent-remote-web OAuth client. authserver's validateRedirectURI compares this
// value byte-for-byte against the incoming redirect_uri, so it must be
// exactly the URL the browser will actually be sent back to.
func webRedirectURIFor(addr string, sc config.ServerConfig) string {
	return publicBaseURL(addr, sc) + "/auth/callback"
}

func authDir() string {
	return filepath.Join(filepath.Dir(config.DefaultPath()), "auth")
}

// newAuthServer wires the owner-only passkey/TOTP credential store into the
// existing OAuth 2.1 authorization server. The browser origin is fixed at
// startup from the same topology-aware seam as the OAuth redirect URI, so
// WebAuthn never trusts request Host or forwarded headers.
func newAuthServer(addr string, sc config.ServerConfig) (*authserver.AuthServer, error) {
	credentials, err := authserver.NewCredentialStore(authDir())
	if err != nil {
		return nil, err
	}

	return authserver.New(authserver.Config{
		WebRedirectURI:  webRedirectURIFor(addr, sc),
		PublicOrigin:    publicBaseURL(addr, sc),
		CredentialStore: credentials,
		TokenStoreDir:   authDir(),
		RateLimiter:     authserver.NewRateLimiter(5, 15*time.Minute),
	})
}

func runAuthCommand(cfg Config) error {
	dir := authDir()
	switch cfg.AuthAction {
	case "init":
		resolved, _ := config.Load(config.DefaultPath())
		setupOrigin := "http://localhost:8311"
		if cfg.AuthOrigin != "" {
			override := config.ServerConfig{BehindReverseProxy: true, PublicOrigin: cfg.AuthOrigin}
			if err := override.Validate(); err != nil {
				return err
			}
			setupOrigin = override.BaseURL()
		} else if resolved.Server.BehindReverseProxy {
			if err := resolved.Server.Validate(); err != nil {
				return err
			}
			setupOrigin = resolved.Server.BaseURL()
		}
		store, err := authserver.NewCredentialStore(dir)
		if err != nil {
			return err
		}
		code, expires, err := store.BeginBootstrap()
		if err != nil {
			return err
		}
		fmt.Printf("Setup URL:  %s/auth/setup\n", setupOrigin)
		fmt.Printf("Setup code: %s\n", code)
		fmt.Printf("Expires:    %s\n", expires.Local().Format(time.RFC1123))
		return nil
	case "status":
		store, err := authserver.NewCredentialStore(dir)
		if err != nil {
			return err
		}
		status, err := store.Status()
		if err != nil {
			return err
		}
		state := "not configured"
		if status.Active {
			state = "active"
		} else if status.BootstrapPending {
			state = "setup pending"
		}
		fmt.Printf("Authentication: %s\n", state)
		fmt.Printf("Passkeys:      %d\n", status.PasskeyCount)
		fmt.Printf("Recovery codes: %d remaining\n", status.RecoveryRemaining)
		if status.BootstrapPending {
			fmt.Printf("Setup expires: %s\n", status.BootstrapExpires.Local().Format(time.RFC1123))
		}
		return nil
	case "reset":
		if !cfg.AuthResetYes {
			return errors.New("auth reset removes all credentials and sessions; rerun with --yes to confirm")
		}
		if err := authserver.ResetAuthFiles(dir); err != nil {
			return err
		}
		fmt.Println("Authentication credentials and sessions removed.")
		fmt.Println("Restart Agent Remote, then run `agent-remote auth init`.")
		return nil
	default:
		return fmt.Errorf("unknown auth action %q", cfg.AuthAction)
	}
}

// runLocal starts agent-remote in local mode: starts the HTTP server on localhost,
// wires the per-browser sessiond dialer, opens a browser, and blocks until
// shutdown.
func runLocal(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Local mode is loopback-only BY DEFINITION and deliberately ignores
	// the [server] section entirely: it never reads that section off the
	// resolved config, never applies serve mode's flag-over-file
	// resolution to it, and never runs its startup validation. (Those three
	// names are deliberately not spelled out here: the C4 guard greps this
	// function body for them, and even a mention in a comment trips it.)
	// Bare `agent-remote` on a host whose config.toml sets behind_reverse_proxy =
	// true — i.e. the production host — must still behave exactly as it
	// does today: loopback bypass on, loopback-derived redirect URI, no
	// startup error. Honoring the file here would send the *local* browser
	// to the public origin and turn the bypass off, breaking local
	// interactive use on the one machine where it matters most. Only
	// `serve` mode honors the new fields.
	//
	// The explicit zero config.ServerConfig{} below is what pins that:
	// BehindReverseProxy is false, so webRedirectURIFor falls through to
	// the pre-existing loopback derivation, byte-for-byte unchanged.
	localServerCfg := config.ServerConfig{}

	authSrv, err := newAuthServer(cfg.Addr, localServerCfg)
	if err != nil {
		log.Printf("agent-remote: authentication unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:          cfg.Addr,
		StaticFS:      mustSubFS(webstatic.Dist, "dist"),
		ConfigPath:    config.DefaultPath(),
		InitialConfig: resolved,
		AuthServer:    authSrv,
		// No BehindReverseProxy field is set: local mode leaves it at its
		// zero false, keeping the IsLocalhost() bypass exactly as today.
		WebRedirectURI: webRedirectURIFor(cfg.Addr, localServerCfg),
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

	// Publish serve-layer URL so the MCP server can discover the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr); err != nil {
		log.Printf("agent-remote: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	browserHost := cfg.Addr
	if _, port, err := net.SplitHostPort(cfg.Addr); err == nil {
		browserHost = "localhost:" + port
	}
	go openBrowser("http://" + browserHost)

	log.Printf("agent-remote listening on %s", cfg.Addr)
	return srv.ListenAndServe(ctx)
}

// runServe starts agent-remote in serve mode, wires the per-browser sessiond dialer,
// and blocks until shutdown. The daemon is ensured lazily by the dialer (per
// browser), which is a no-op under systemd where the daemon is its own unit.
func runServe(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Serve mode is the ONLY mode that honors the [server] section. Fail
	// closed BEFORE the listener binds: an ambiguous or misconfigured
	// security posture must deny, never silently downgrade to a
	// loopback-derived URL (which is the exact bug Phase 3 fixes).
	srvCfg := resolveServerConfig(cfg, resolved.Server)
	if err := srvCfg.Validate(); err != nil {
		return err
	}

	authSrv, err := newAuthServer(cfg.Addr, srvCfg)
	if err != nil {
		log.Printf("agent-remote: authentication unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:               cfg.Addr,
		StaticFS:           mustSubFS(webstatic.Dist, "dist"),
		NoAuth:             cfg.NoAuth,
		ConfigPath:         config.DefaultPath(),
		InitialConfig:      resolved,
		AuthServer:         authSrv,
		WebRedirectURI:     webRedirectURIFor(cfg.Addr, srvCfg),
		BehindReverseProxy: srvCfg.BehindReverseProxy,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

	// Publish serve-layer URL so the MCP server can discover the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr); err != nil {
		log.Printf("agent-remote: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("agent-remote listening on %s", cfg.Addr)
	return srv.ListenAndServe(ctx)
}

// runDeploy deploys agent-remote to a remote host via SSH.
func runDeploy(cfg Config) error {
	d, err := deploy.New()
	if err != nil {
		return fmt.Errorf("deploy init: %w", err)
	}
	return d.Deploy(cfg.Target)
}

// runInstall installs agent-remote as a system service.
func runInstall(cfg Config) error {
	svcCfg := service.ServiceConfig{
		Addr:   cfg.Addr,
		Secret: cfg.Secret,
		Force:  cfg.Force,
	}
	if err := service.Install(svcCfg); err != nil {
		return err
	}
	fmt.Printf("Agent Remote installed and running at http://%s\n", cfg.Addr)
	return nil
}

// runUninstall removes the agent-remote system service.
func runUninstall() error {
	if err := service.Uninstall(); err != nil {
		return err
	}
	fmt.Println("Agent Remote service removed")
	return nil
}

// runWithGracefulShutdown blocks until srv stops or a SIGINT/SIGTERM is received,
// then performs a graceful shutdown. This consolidates the signal-handling pattern
// shared by runLocal and runServe and is the canonical way to start the server
// in a signal-aware manner from a *server.Server value.
func runWithGracefulShutdown(srv *server.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.ListenAndServe(ctx)
}

// openBrowser opens the given URL in the default browser. Non-fatal if it fails.
func openBrowser(url string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	default:
		return
	}
	if err := exec.Command(cmd, url).Start(); err != nil {
		log.Printf("failed to open browser: %v", err)
	}
}

// runAmplifierBundleInstall adds the agent-remote Amplifier bundle as an app bundle
// by running: amplifier bundle add --app git+https://github.com/maxbaines/agent-remote@main#subdirectory=bundle
// The --app flag makes the bundle active on every Amplifier session, not just
// when explicitly selected.
func runAmplifierBundleInstall() error {
	const bundleURI = "git+https://github.com/maxbaines/agent-remote@main#subdirectory=bundle"

	cmd := exec.Command("amplifier", "bundle", "add", "--app", bundleURI)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("amplifier bundle add failed: %w\n\nMake sure 'amplifier' is installed and on your PATH.", err)
	}
	return nil
}

// runMCPCommand starts the MCP server with stdio transport. stdout is the
// JSON-RPC transport; all logging is redirected to stderr so it does not
// corrupt the wire protocol. Only the "stdio" transport is supported in Phase
// 4; SSE will be added in Phase 5.
func runMCPCommand(cfg Config) error {
	if cfg.Transport != "stdio" {
		return fmt.Errorf("unsupported MCP transport %q: only stdio supported; SSE arrives in Phase 5", cfg.Transport)
	}
	// Redirect all log output to stderr so stdout stays clean for JSON-RPC.
	log.SetOutput(os.Stderr)

	srv, closer := mcp.NewStdioServer()
	defer closer() //nolint:errcheck

	log.Printf("mcp: stdio server ready")
	return srv.Run()
}

// mustSubFS returns a sub-FS rooted at dir, panicking on error (embed paths
// are fixed at compile time so a panic here means a programming error).
func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("web embed sub: %v", err))
	}
	return sub
}
