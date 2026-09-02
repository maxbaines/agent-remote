// Package tunnelorigin parses the operator-configured wildcard origin used by
// local-app tunnels and maps between tunnel IDs, public URLs, and Host headers.
package tunnelorigin

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

const placeholder = "{id}"

// Origin is a validated public origin template such as
// https://{id}.apps.example.com. Its zero value means tunnels are unavailable.
type Origin struct {
	scheme string
	suffix string
	port   string
}

// Parse validates a tunnel origin. The {id} placeholder must be the complete
// left-most hostname label so one configured wildcard DNS/TLS route can serve
// every tunnel without trusting forwarded headers.
func Parse(raw string) (Origin, error) {
	if raw == "" {
		return Origin{}, nil
	}
	if strings.Count(raw, placeholder) != 1 {
		return Origin{}, fmt.Errorf("tunnel origin %q must contain exactly one {id} placeholder", raw)
	}

	const probeID = "jtprobe"
	parsed, err := url.Parse(strings.Replace(raw, placeholder, probeID, 1))
	if err != nil {
		return Origin{}, fmt.Errorf("tunnel origin %q is not a valid URL: %w", raw, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Origin{}, fmt.Errorf("tunnel origin %q must use the http or https scheme", raw)
	}
	if parsed.Host == "" {
		return Origin{}, fmt.Errorf("tunnel origin %q must include a host", raw)
	}
	if parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return Origin{}, fmt.Errorf("tunnel origin %q must contain only a scheme and wildcard host", raw)
	}

	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	prefix := probeID + "."
	if !strings.HasPrefix(hostname, prefix) || strings.Contains(strings.TrimPrefix(hostname, prefix), placeholder) {
		return Origin{}, fmt.Errorf("tunnel origin %q must use {id} as its complete left-most hostname label", raw)
	}
	suffix := strings.TrimPrefix(hostname, prefix)
	if suffix == "" {
		return Origin{}, fmt.Errorf("tunnel origin %q must include a domain after {id}", raw)
	}
	if parsed.Scheme != "https" && suffix != "localhost" && !strings.HasSuffix(suffix, ".localhost") {
		return Origin{}, fmt.Errorf("tunnel origin %q must use https outside localhost", raw)
	}

	return Origin{scheme: parsed.Scheme, suffix: suffix, port: parsed.Port()}, nil
}

// Configured reports whether an origin was supplied.
func (o Origin) Configured() bool {
	return o.scheme != ""
}

// Secure reports whether browser cookies for this origin require HTTPS.
func (o Origin) Secure() bool {
	return o.scheme == "https"
}

// AccessURL builds the capability URL used to establish a host-only tunnel
// cookie. The secret stays in the fragment, so it is not sent to reverse-proxy
// access logs or to the tunneled application.
func (o Origin) AccessURL(id, token string) string {
	host := id + "." + o.suffix
	if o.port != "" {
		host = net.JoinHostPort(host, o.port)
	}
	fragment := url.Values{"token": {token}}.Encode()
	return o.scheme + "://" + host + "/_just-terminal/connect#" + fragment
}

// TunnelID extracts a single-label tunnel ID from a request Host. Only hosts
// beneath the configured suffix match; unrelated hosts stay on the main JT
// router.
func (o Origin) TunnelID(hostport string) (string, bool) {
	if !o.Configured() {
		return "", false
	}
	host := hostport
	if splitHost, _, err := net.SplitHostPort(hostport); err == nil {
		host = splitHost
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	suffix := "." + o.suffix
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	id := strings.TrimSuffix(host, suffix)
	if id == "" || strings.Contains(id, ".") {
		return "", false
	}
	for _, ch := range id {
		if !((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
			return "", false
		}
	}
	return id, true
}
