// Package update implements JustTerminal's verified self-update flow.
package update

import (
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

var gitDescribeRe = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}(-dirty)?$`)
var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// IsDev reports whether v identifies a locally built rather than released binary.
func IsDev(v string) bool {
	if v == "" || v == "dev" {
		return true
	}
	v = strings.TrimPrefix(v, "v")
	return strings.HasSuffix(v, "-dirty") || gitDescribeRe.MatchString(v) || !semverRe.MatchString(v)
}

// Newer reports whether candidate is a strictly newer release than current.
func Newer(current, candidate string) bool {
	cur, curPre, ok := parseVersion(current)
	if !ok {
		return false
	}
	cand, candPre, ok := parseVersion(candidate)
	if !ok {
		return false
	}
	for i := range cur {
		if cand[i] != cur[i] {
			return cand[i] > cur[i]
		}
	}
	return curPre != "" && candPre == ""
}

func parseVersion(v string) (nums [3]int, prerelease string, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		prerelease = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nums, "", false
	}
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, prerelease, true
}

// Method describes how this installation is updated.
type Method string

const (
	MethodBinary      Method = "binary"
	MethodContainer   Method = "container"
	MethodUnsupported Method = "unsupported"
)

// Platform reports how this installation is updated. Container images opt out
// explicitly: mutating a binary in a running container is ephemeral and would
// bypass the operator's normal image rollout.
func Platform() (Method, string) {
	if os.Getenv("JUST_TERMINAL_UPDATE_METHOD") == string(MethodContainer) {
		return MethodContainer, "Updates are managed by the container image; pull and redeploy the image to update."
	}
	switch {
	case runtime.GOOS == "darwin" && (runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64"):
		return MethodBinary, ""
	case runtime.GOOS == "linux" && runtime.GOARCH == "amd64":
		return MethodBinary, ""
	default:
		return MethodUnsupported, fmt.Sprintf("No release build is published for %s/%s.", runtime.GOOS, runtime.GOARCH)
	}
}
