//go:build darwin

package sessiond

import (
	"bytes"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	darwinProcInfoCallPIDInfo   = 2
	darwinProcPIDVnodePathInfo  = 9
	darwinVnodeInfoSize         = 152
	darwinMaxPathLen            = 1024
	darwinProcVnodePathInfoSize = 2 * (darwinVnodeInfoSize + darwinMaxPathLen)
)

func processWorkingDirectory(pid int) (string, error) {
	buffer := make([]byte, darwinProcVnodePathInfoSize)
	written, _, errno := syscall.Syscall6(
		syscall.SYS_PROC_INFO,
		darwinProcInfoCallPIDInfo,
		uintptr(pid),
		darwinProcPIDVnodePathInfo,
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if errno != 0 {
		return "", errno
	}
	if int(written) < darwinVnodeInfoSize+1 {
		return "", fmt.Errorf("proc_info returned %d bytes", written)
	}

	path := buffer[darwinVnodeInfoSize : darwinVnodeInfoSize+darwinMaxPathLen]
	if end := bytes.IndexByte(path, 0); end >= 0 {
		path = path[:end]
	}
	if len(path) == 0 {
		return "", fmt.Errorf("proc_info returned an empty cwd")
	}
	return string(path), nil
}
