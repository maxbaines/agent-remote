//go:build linux

package sessiond

import (
	"os"
	"strconv"
)

func processWorkingDirectory(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}
