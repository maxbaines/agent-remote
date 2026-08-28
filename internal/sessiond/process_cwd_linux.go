//go:build linux

package sessiond

import (
	"os"
	"strconv"
	"strings"
)

func processWorkingDirectory(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}

func processCommand(pid int) (string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.ReplaceAll(string(raw), "\x00", " "))
	return strings.Join(fields, " "), nil
}
