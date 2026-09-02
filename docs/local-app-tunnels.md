# Local app tunnels

JustTerminal gives every exposed local app the root of a separate hostname:

```text
https://a7k2q.apps.example.com/  →  127.0.0.1:5173
```

The five-character label is allocated when a port is exposed. DNS records and
proxy routes are not created per app: one wildcard DNS record, certificate, and
reverse-proxy rule cover every future tunnel.

## Requirements

Choose two origins:

```text
JustTerminal UI:  https://terminal.example.com
Local apps:       https://{id}.apps.example.com
```

Then configure:

1. DNS `A`/`AAAA` records for `terminal.example.com` and
   `*.apps.example.com` pointing at the ingress.
2. TLS for `terminal.example.com` and `*.apps.example.com`. A wildcard covers
   exactly one label, so `*.example.com` does not cover
   `a7k2q.apps.example.com`.
3. Both host patterns routed to the same JustTerminal container port (8311).
4. The original `Host` header preserved and WebSocket upgrades allowed.
5. JustTerminal configured with trusted origins rather than forwarded headers:

   ```bash
   just-terminal serve \
     --addr 0.0.0.0:8311 \
     --behind-reverse-proxy \
     --public-origin https://terminal.example.com \
     --tunnel-origin 'https://{id}.apps.example.com'
   ```

   The Docker image accepts the equivalent variables:

   ```env
   JUST_TERMINAL_PUBLIC_ORIGIN=https://terminal.example.com
   JUST_TERMINAL_TUNNEL_ORIGIN=https://{id}.apps.example.com
   ```

Apps started from a JustTerminal terminal normally share its container network
namespace. They must listen on IPv4 loopback (`127.0.0.1`) or all interfaces
(`0.0.0.0`). Apps running on the Docker host or in a sibling container are not
reachable through the loopback tunnel.

## Caddy 2

Caddy requires the DNS challenge for publicly trusted wildcard certificates;
that generally means a Caddy build containing the module for your DNS provider.
The [Caddy wildcard certificate documentation](https://caddyserver.com/docs/automatic-https#wildcard-certificates)
describes that requirement.

```caddyfile
terminal.example.com {
    reverse_proxy just-terminal:8311 {
        header_up Host {host}
    }
}

*.apps.example.com {
    tls {
        dns <provider> <credentials>
    }
    reverse_proxy just-terminal:8311 {
        header_up Host {host}
    }
}
```

Replace `just-terminal` with the container name or reachable upstream address.
Caddy's `reverse_proxy` handles WebSocket upgrades automatically.

## Apache HTTP Server 2.4

Enable `mod_ssl`, `mod_proxy`, and `mod_proxy_http`, then use a certificate that
covers the relevant virtual host. Apache 2.4.47 and newer can proxy WebSocket
upgrades through `mod_proxy_http`; see the
[Apache WebSocket proxy documentation](https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html).

```apache
<VirtualHost *:443>
    ServerName terminal.example.com
    SSLEngine On
    SSLCertificateFile /etc/ssl/terminal/fullchain.pem
    SSLCertificateKeyFile /etc/ssl/terminal/privkey.pem

    ProxyPreserveHost On
    ProxyPass        "/" "http://just-terminal:8311/" upgrade=websocket
    ProxyPassReverse "/" "http://just-terminal:8311/"
</VirtualHost>

<VirtualHost *:443>
    ServerName apps.example.com
    ServerAlias *.apps.example.com
    SSLEngine On
    SSLCertificateFile /etc/ssl/apps/fullchain.pem
    SSLCertificateKeyFile /etc/ssl/apps/privkey.pem

    ProxyPreserveHost On
    ProxyPass        "/" "http://just-terminal:8311/" upgrade=websocket
    ProxyPassReverse "/" "http://just-terminal:8311/"
</VirtualHost>
```

## Traefik

Route the exact UI hostname and the wildcard app hostname to the same service.
Use `HostRegexp` for the generated app labels. The
[Traefik router documentation](https://doc.traefik.io/traefik/routing/routers/#host-and-hostregexp)
describes the matcher.

```yaml
http:
  routers:
    just-terminal:
      rule: Host(`terminal.example.com`)
      entryPoints: [websecure]
      service: just-terminal
      tls: {}
    just-terminal-apps:
      rule: HostRegexp(`^[a-z0-9]+\.apps\.example\.com$`)
      entryPoints: [websecure]
      service: just-terminal
      tls:
        domains:
          - main: apps.example.com
            sans: ['*.apps.example.com']
  services:
    just-terminal:
      loadBalancer:
        servers:
          - url: http://just-terminal:8311
```

Wildcard certificates require an ACME DNS challenge or a pre-provisioned
certificate.

## Coolify

Coolify's normal domain field handles the exact JustTerminal hostname. Catching
every tunnel hostname requires its multi-domain/SaaS routing mode:

1. Add `*.apps.example.com` in DNS.
2. Configure a wildcard certificate through the Coolify proxy's DNS challenge.
3. Keep `https://terminal.example.com:8311` as the application's normal domain.
4. Disable read-only container labels and add a second Traefik router using
   `HostRegexp` for `^[a-z0-9]+\.apps\.example\.com$`, targeting the same
   Coolify service and container port 8311.
5. Set `JUST_TERMINAL_TUNNEL_ORIGIN=https://{id}.apps.example.com` and redeploy.

Coolify documents the required catch-all labels under
[Wildcard SSL Certificates → SaaS](https://coolify.io/docs/knowledge-base/proxy/traefik/wildcard-certs)
and the DNS record under
[Wildcard Domains](https://coolify.io/docs/knowledge-base/dns-configuration#wildcard-domains).

If Coolify is using Caddy rather than Traefik, add the equivalent wildcard site
to the Coolify Caddy configuration using the Caddy recipe above.

## Authentication and isolation

The Local Apps UI returns a capability URL whose secret is stored in the URL
fragment. Fragments are not sent in HTTP requests or reverse-proxy access logs.
A small JT-owned connection page exchanges the secret for a host-only,
HttpOnly cookie and removes the fragment before loading the app.

The Gateway consumes that cookie and never forwards it upstream. Application
cookies and `Authorization` headers are preserved. Since every app has a
separate origin, an exposed app cannot make same-origin requests to
JustTerminal's main `/api` or `/ws` routes.

## Verification

Before creating a tunnel, confirm that the wildcard reaches JustTerminal:

```bash
curl -I https://does-not-exist.apps.example.com/
```

A JustTerminal `404 local app not found` proves DNS, TLS, and host routing are
working. Then expose a running port in **Settings → Local apps** and open the
generated URL. The app should load from `/`, and its HTTP endpoints, WebSockets,
and cookies should remain on that tunnel hostname.
