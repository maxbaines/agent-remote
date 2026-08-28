//go:build !darwin && !linux

package sessiond

import (
	"fmt"
	"os"
)

func foregroundProcessID(_ *os.File) (int, error) {
	return 0, fmt.Errorf("foreground process lookup is unsupported on this platform")
}

func processWorkingDirectory(_ int) (string, error) {
	return "", fmt.Errorf("process cwd lookup is unsupported on this platform")
}

func processCommand(_ int) (string, error) {
	return "", fmt.Errorf("process command lookup is unsupported on this platform")
}
