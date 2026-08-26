package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

// Config holds the parsed CLI configuration.
type Config struct {
	Mode         string // local, serve, sessiond, deploy, install, uninstall, doctor, version, mcp, auth, amplifier-install, help
	Addr         string // listen address
	Secret       string // auth token for serve mode
	NoAuth       bool   // skip WebSocket auth check (dev only — never use in production)
	Target       string // SSH target for deploy mode
	Force        bool   // install: overwrite existing service installation
	Transport    string // mcp mode: transport type ("stdio"); SSE arrives in Phase 5
	MCPPort      int    // mcp mode: SSE port (Phase 5, parsed but rejected for now)
	AuthAction   string // auth mode: init, status, or reset
	AuthOrigin   string // auth init: optional setup URL origin override
	AuthResetYes bool   // auth reset: explicit destructive confirmation

	// PublicOrigin is the serve-mode --public-origin override for the
	// config file's [server].public_origin. Empty means "unset — use the
	// config file value."
	PublicOrigin string
	// BehindReverseProxy is the serve-mode --behind-reverse-proxy override
	// for the config file's [server].behind_reverse_proxy. false means
	// "unset — use the config file value"; the flag can only turn the
	// setting on, never off (same one-way bool limitation config.Merge
	// documents).
	BehindReverseProxy bool
}

// printUsage writes top-level help to w.
func printUsage(w io.Writer) {
	fmt.Fprintln(w, "Agent Remote — persistent browser terminal workspace")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  agent-remote                     Open in browser (127.0.0.1:8311, default)")
	fmt.Fprintln(w, "  agent-remote serve [flags]       Start server for remote access")
	fmt.Fprintln(w, "  agent-remote install [flags]     Install as a system service")
	fmt.Fprintln(w, "  agent-remote uninstall           Remove system service")
	fmt.Fprintln(w, "  agent-remote deploy <host>       Deploy to a remote host via SSH")
	fmt.Fprintln(w, "  agent-remote doctor              Check daemon and service status")
	fmt.Fprintln(w, "  agent-remote mcp [flags]         Start MCP server (stdio transport)")
	fmt.Fprintln(w, "  agent-remote auth <command>      Initialize or recover authentication")
	fmt.Fprintln(w, "  agent-remote amplifier install   Install agent-remote bundle into Amplifier")
	fmt.Fprintln(w, "  agent-remote version             Print version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Run 'agent-remote <command> --help' for command-specific flags.")
}

// ParseArgs parses command-line arguments and returns a Config.
// It is a pure function with no side effects beyond flag parsing.
func ParseArgs(args []string) (Config, error) {
	if len(args) == 0 {
		return Config{
			Mode: "local",
			Addr: "127.0.0.1:8311",
		}, nil
	}

	switch args[0] {
	case "--help", "-h", "help":
		return Config{Mode: "help"}, nil
	case "serve":
		return parseServe(args[1:])
	case "sessiond":
		return Config{Mode: "sessiond"}, nil
	case "deploy":
		return parseDeploy(args[1:])
	case "version":
		return Config{Mode: "version"}, nil
	case "install":
		return parseInstall(args[1:])
	case "uninstall":
		return Config{Mode: "uninstall"}, nil
	case "doctor":
		return Config{Mode: "doctor"}, nil
	case "mcp":
		return parseMCP(args[1:])
	case "auth":
		return parseAuth(args[1:])
	case "amplifier":
		return parseAmplifier(args[1:])
	default:
		return Config{}, fmt.Errorf("unknown command %q\n\nRun 'agent-remote --help' for usage.", args[0])
	}
}

func parseAuth(args []string) (Config, error) {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote auth <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  init      Create a single-use browser setup code")
		fmt.Fprintln(os.Stdout, "  status    Show non-secret authentication status")
		fmt.Fprintln(os.Stdout, "  reset     Remove credentials and sessions (requires --yes)")
		return Config{Mode: "help"}, nil
	}

	switch args[0] {
	case "init":
		fs := flag.NewFlagSet("auth init", flag.ContinueOnError)
		fs.SetOutput(os.Stdout)
		origin := fs.String("origin", "", "public browser origin for the printed setup URL")
		fs.Usage = func() {
			fmt.Fprintln(os.Stdout, "Usage: agent-remote auth init [--origin https://agent-remote.example.com]")
			fs.PrintDefaults()
		}
		if err := fs.Parse(args[1:]); err != nil {
			return Config{}, err
		}
		if fs.NArg() != 0 {
			return Config{}, fmt.Errorf("auth init does not accept positional arguments")
		}
		return Config{Mode: "auth", AuthAction: "init", AuthOrigin: *origin}, nil
	case "status":
		if len(args) != 1 {
			return Config{}, fmt.Errorf("auth status does not accept arguments")
		}
		return Config{Mode: "auth", AuthAction: "status"}, nil
	case "reset":
		fs := flag.NewFlagSet("auth reset", flag.ContinueOnError)
		fs.SetOutput(os.Stdout)
		yes := fs.Bool("yes", false, "confirm removal of all passkeys, TOTP, recovery codes, and sessions")
		fs.Usage = func() {
			fmt.Fprintln(os.Stdout, "Usage: agent-remote auth reset --yes")
			fs.PrintDefaults()
		}
		if err := fs.Parse(args[1:]); err != nil {
			return Config{}, err
		}
		if fs.NArg() != 0 {
			return Config{}, fmt.Errorf("auth reset does not accept positional arguments")
		}
		return Config{Mode: "auth", AuthAction: "reset", AuthResetYes: *yes}, nil
	default:
		return Config{}, fmt.Errorf("unknown auth command %q", args[0])
	}
}

func parseAmplifier(args []string) (Config, error) {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote amplifier <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  install    Add the Agent Remote bundle to Amplifier as an app bundle")
		return Config{Mode: "help"}, nil
	}
	switch args[0] {
	case "install":
		return Config{Mode: "amplifier-install"}, nil
	default:
		return Config{}, fmt.Errorf("unknown amplifier command %q\n\nRun 'agent-remote amplifier --help' for usage.", args[0])
	}
}

func parseMCP(args []string) (Config, error) {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	transport := fs.String("transport", "stdio", "MCP transport type (only 'stdio' supported; SSE arrives in Phase 5)")
	port := fs.Int("port", 9092, "MCP SSE port (Phase 5, parsed but rejected for now)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote mcp [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Start MCP server using stdio transport (JSON-RPC 2.0 over stdin/stdout).")
		fmt.Fprintln(os.Stdout, "stdout is the JSON-RPC transport; all logging goes to stderr.")
		fmt.Fprintln(os.Stdout, "Exposes terminal, workspace, layout, and browser automation tools, plus pane:// resources.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:      "mcp",
		Transport: *transport,
		MCPPort:   *port,
	}, nil
}

func parseServe(args []string) (Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	addr := fs.String("addr", "127.0.0.1:8311", "listen address")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	noAuth := fs.Bool("no-auth", false, "skip WebSocket auth check (dev only — never use in production)")
	publicOrigin := fs.String("public-origin", "", "canonical public origin when behind a reverse proxy (e.g. https://agent-remote.example.com); required with --behind-reverse-proxy")
	behindProxy := fs.Bool("behind-reverse-proxy", false, "run behind a reverse proxy: derive public URLs from --public-origin and disable the loopback auth bypass")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote serve [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Start the Agent Remote Gateway for remote/shared access with optional authentication.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:               "serve",
		Addr:               *addr,
		Secret:             *secret,
		NoAuth:             *noAuth,
		PublicOrigin:       *publicOrigin,
		BehindReverseProxy: *behindProxy,
	}, nil
}

func parseDeploy(args []string) (Config, error) {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote deploy <host>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Deploy Agent Remote to a remote Host via SSH.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Arguments:")
		fmt.Fprintln(os.Stdout, "  <host>    SSH target (e.g. user@hostname)")
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() < 1 {
		return Config{}, fmt.Errorf("deploy requires a target argument (e.g. user@host)")
	}
	return Config{
		Mode:   "deploy",
		Target: fs.Arg(0),
	}, nil
}

func parseInstall(args []string) (Config, error) {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	addr := fs.String("addr", "127.0.0.1:8311", "listen address for the service")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	force := fs.Bool("force", false, "stop and overwrite an existing installation")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: agent-remote install [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Install Agent Remote as a system service (systemd on Linux, launchd on macOS).")
		fmt.Fprintln(os.Stdout, "Use --force to stop and overwrite an existing installation.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "install",
		Addr:   *addr,
		Secret: *secret,
		Force:  *force,
	}, nil
}
