//go:build darwin

package sessiond

import "golang.org/x/sys/unix"

// tcgetsRequest is Darwin's ioctl request for reading terminal attributes.
const tcgetsRequest = unix.TIOCGETA
