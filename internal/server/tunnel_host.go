package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

const (
	tunnelCookieName        = "just-terminal_tunnel"
	tunnelConnectPath       = "/_just-terminal/connect"
	tunnelConnectScriptPath = "/_just-terminal/connect.js"
	tunnelAuthPath          = "/_just-terminal/auth"
)

const tunnelConnectScript = `(() => {
  const status = document.getElementById('status');
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) {
    status.textContent = 'This local-app link is missing its access token. Open it again from JustTerminal.';
    return;
  }
  fetch('/_just-terminal/auth', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token}),
  }).then((response) => {
    if (!response.ok) throw new Error('Access denied (' + response.status + ')');
    location.replace('/');
  }).catch((error) => {
    status.textContent = error instanceof Error ? error.message : 'Could not open this local app.';
  });
})();`

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if id, ok := s.tunnelOrigin.TunnelID(r.Host); ok {
		s.handleTunnelHost(w, r, id)
		return
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleTunnelHost(w http.ResponseWriter, r *http.Request, id string) {
	entry, ok := s.tunnels.Entry(id)
	if !ok {
		http.Error(w, "local app not found", http.StatusNotFound)
		return
	}

	switch r.URL.Path {
	case tunnelConnectPath:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.serveTunnelConnect(w)
		return
	case tunnelConnectScriptPath:
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprint(w, tunnelConnectScript)
		return
	case tunnelAuthPath:
		s.handleTunnelAuth(w, r, entry)
		return
	}

	if !tunnelRequestAuthorized(r, entry.token) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.Redirect(w, r, tunnelConnectPath, http.StatusFound)
			return
		}
		http.Error(w, "local app access denied", http.StatusUnauthorized)
		return
	}

	s.proxyTunnelRequest(w, r, entry)
}

func (s *Server) serveTunnelConnect(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening local app…</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#e5e7eb;font:15px system-ui,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}p{color:#9ca3af}</style></head><body><main><h1>Opening local app…</h1><p id="status">Establishing a private tunnel session.</p></main><script src="/_just-terminal/connect.js"></script></body></html>`)
}

func (s *Server) handleTunnelAuth(w http.ResponseWriter, r *http.Request, entry tunnelInfoServer) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !sameToken(body.Token, entry.token) {
		http.Error(w, "invalid local-app token", http.StatusForbidden)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     tunnelCookieName,
		Value:    entry.token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.tunnelOrigin.Secure(),
		SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func tunnelRequestAuthorized(r *http.Request, token string) bool {
	cookie, err := r.Cookie(tunnelCookieName)
	return err == nil && sameToken(cookie.Value, token)
}

func sameToken(got, want string) bool {
	return len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) proxyTunnelRequest(w http.ResponseWriter, r *http.Request, entry tunnelInfoServer) {
	target := &url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort("127.0.0.1", strconv.Itoa(entry.port)),
	}
	cloned := r.Clone(r.Context())
	cloned.Header.Del("Cookie")
	for _, cookie := range r.Cookies() {
		if cookie.Name != tunnelCookieName {
			cloned.AddCookie(cookie)
		}
	}
	cloned.URL.Scheme = target.Scheme
	cloned.URL.Host = target.Host
	cloned.Host = target.Host

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, "local app unavailable: "+err.Error(), http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, cloned)
}
