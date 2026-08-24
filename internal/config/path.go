package config

import (
	"os"
	"path/filepath"
)

// DefaultPath returns the default path to the agent-remote config file.
// It follows the XDG Base Directory specification:
//   - If XDG_CONFIG_HOME is set, uses $XDG_CONFIG_HOME/agent-remote/config.toml
//   - Otherwise falls back to $HOME/.config/agent-remote/config.toml
func DefaultPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "agent-remote", "config.toml")
}
