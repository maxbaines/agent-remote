//go:build darwin || linux

package sessiond

import (
	"os"
	"syscall"
	"unsafe"
)

// foregroundProcessID returns the process-group leader currently in the
// foreground of the Pane's PTY. Interactive shells create one process group
// per job, and a nested interactive shell remains its group's leader, making
// this a better cwd source than the original shell PID alone.
func foregroundProcessID(ptmx *os.File) (int, error) {
	var processGroupID int32
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		ptmx.Fd(),
		uintptr(syscall.TIOCGPGRP),
		uintptr(unsafe.Pointer(&processGroupID)),
	)
	if errno != 0 {
		return 0, errno
	}
	return int(processGroupID), nil
}
