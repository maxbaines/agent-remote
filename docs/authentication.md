# Authentication

JustTerminal uses a single-owner, self-hosted authentication system:

- Passkeys are the primary sign-in method. Registration and login require user verification and a discoverable credential.
- TOTP is enrolled during setup but is not an everyday second factor. It is used only for recovery, together with one unused recovery code.
- Ten high-entropy recovery codes are created at activation. Only their SHA-256 digests are stored, and each successful recovery removes one code.
- Existing OAuth 2.1 authorization-code and PKCE machinery issues the browser's opaque session token after the owner proves access.
- Loopback requests retain the existing local bypass. Reverse-proxy mode disables that bypass completely.

There is no identity SaaS, email delivery, external database, Better Auth, or Resend dependency.

## Initial setup

WebAuthn credentials are scoped to a relying-party hostname, so configure the final browser origin before enrollment. Remote origins must use HTTPS; the `localhost` hostname is the browser-supported development exception. Use a hostname rather than an IP address.

In `~/.config/just-terminal/config.toml`, or `$XDG_CONFIG_HOME/just-terminal/config.toml` when that variable is set:

```toml
[server]
behind_reverse_proxy = true
public_origin = "https://my-instance.js.actor"
```

Start JustTerminal behind the TLS reverse proxy using the same configuration. Then, from a shell on the JustTerminal host:

```bash
just-terminal auth init
```

`auth init` writes a hash of a random 128-bit bootstrap code to the local credential store and prints the plaintext code once. The code expires after ten minutes and is consumed when the setup browser session is unlocked. Generating another code replaces any incomplete enrollment, but it refuses to replace an active configuration.

The setup URL normally comes from the config file. When the server was started with a command-line-only origin override, pass the same origin to initialization so the printed URL is correct:

```bash
just-terminal auth init --origin https://my-instance.js.actor
```

In the browser:

1. Open the printed `/auth/setup` URL and enter the bootstrap code.
2. Register a passkey. The browser or OS will ask for its normal user-verification gesture.
3. Scan the TOTP QR code, or copy its secret into an authenticator app.
4. Enter a current six-digit authenticator code.
5. Save the recovery codes before continuing. They cannot be retrieved later.

Authentication does not become active until both passkey registration and TOTP confirmation succeed. There is no remotely claimable “first visitor becomes owner” path.

## Normal sign-in and recovery

Normal remote sign-in asks only for the passkey. A successful WebAuthn ceremony creates a short-lived, one-use proof that completes the existing OAuth authorization request and establishes an HttpOnly browser session.

If the passkey is unavailable, expand **Recover access** on the login page and provide both:

- a current six-digit TOTP code; and
- one unused recovery code saved during enrollment.

Recovery consumes that recovery code permanently. It signs the current browser in; it does not enroll a replacement passkey. Once signed in, restore host access or perform the host-local reset procedure as appropriate.

## Host-local administration

```bash
just-terminal auth status
```

prints only whether authentication is active, the passkey count, the number of recovery codes remaining, and any pending setup expiry.

If every credential is lost, run the destructive reset locally on the host:

```bash
just-terminal auth reset --yes
```

This deletes the credential and OAuth token files. Restart JustTerminal to discard any in-memory token state, then run `just-terminal auth init` and enroll again. Reset intentionally cannot be triggered through the browser.

## Storage and security boundary

Authentication data is stored alongside the JustTerminal config under `auth/credentials.json` and `auth/tokens.json`. The directory is forced to mode `0700` and files to `0600`, with atomic temporary-file replacement.

The TOTP seed and passkey public credential record must be recoverable by the server and are therefore stored in the credential file. Recovery codes are not: only normalized hashes are retained. Protect and back up the host account and config directory accordingly.

WebAuthn challenges, setup browser sessions, and passkey login proofs live only in process memory, have short expirations, and are carried by HttpOnly, SameSite cookies. Auth pages are non-cacheable and ship a restrictive Content Security Policy. Failed setup unlocks and recovery attempts are rate-limited per source address.
