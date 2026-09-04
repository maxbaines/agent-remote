//go:build linux

package sessiond

import "golang.org/x/sys/unix"

// tcgetsRequest is Linux's ioctl request for reading terminal attributes.
const tcgetsRequest = unix.TCGETS
