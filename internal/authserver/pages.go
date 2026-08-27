package authserver

const authPageStyle = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #d9e0ee; background: #0f111a; }
.card { width: min(100%, 480px); padding: 32px; border: 1px solid #2a2f42; border-radius: 14px; background: #171a26; box-shadow: 0 24px 70px rgba(0,0,0,.35); }
.brand { margin: 0 0 6px; color: #fff; font-size: 24px; letter-spacing: -.02em; }
.lede { margin: 0 0 24px; color: #959db3; line-height: 1.55; }
.stack { display: grid; gap: 14px; }
label { display: grid; gap: 7px; color: #b7bfd3; font-size: 13px; }
input { width: 100%; padding: 11px 12px; border: 1px solid #343a50; border-radius: 8px; outline: none; color: #fff; background: #10131d; font: inherit; }
input:focus { border-color: #7aa2f7; box-shadow: 0 0 0 3px rgba(122,162,247,.14); }
button, .button { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 42px; padding: 10px 15px; border: 0; border-radius: 8px; color: #0f111a; background: #7aa2f7; font: 600 14px/1 inherit; cursor: pointer; text-decoration: none; }
button.secondary { color: #d9e0ee; background: #282d3e; }
button:disabled { opacity: .55; cursor: wait; }
.error { margin: 0 0 16px; padding: 10px 12px; border: 1px solid #713e4b; border-radius: 8px; color: #ffb8c6; background: #291820; }
.success { color: #9ece6a; }
.muted { color: #959db3; font-size: 13px; line-height: 1.5; }
details { margin-top: 22px; border-top: 1px solid #2a2f42; padding-top: 18px; }
summary { color: #aeb6ca; cursor: pointer; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.secret { overflow-wrap: anywhere; padding: 10px; border-radius: 7px; background: #10131d; color: #c0caf5; }
.qr { display: block; width: 220px; height: 220px; margin: 4px auto; border: 10px solid white; background: white; }
pre { max-height: 300px; overflow: auto; padding: 14px; border-radius: 8px; color: #c0caf5; background: #10131d; line-height: 1.7; }
[hidden] { display: none !important; }
`

const loginPageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · JustTerminal</title><style>` + authPageStyle + `</style></head>
<body><main class="card">
<h1 class="brand">JustTerminal</h1>
{{if .Active}}<p class="lede">Use your passkey to unlock this machine.</p>{{else}}<p class="lede">Authentication has not been configured on this host.</p>{{end}}
{{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
{{if .Active}}
<form method="post" id="oauth-form" class="stack">
{{range $k, $v := .Hidden}}<input type="hidden" name="{{$k}}" value="{{$v}}">{{end}}
<button type="button" id="passkey-button">Continue with passkey</button>
<p id="passkey-error" class="error" role="alert" hidden></p>
<details>
<summary>Recover access</summary>
<div class="stack" style="margin-top:14px">
<p class="muted">Recovery consumes one saved recovery code and also requires a current six-digit authenticator code.</p>
<label>Authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>
<label>Recovery code<input name="recovery_code" autocomplete="off" spellcheck="false"></label>
<button type="submit" name="method" value="recovery" class="secondary">Use recovery credentials</button>
</div></details>
</form>
{{else}}
<div class="stack"><p class="muted">Run <code>just-terminal auth init</code> through a shell on the JustTerminal host, then visit the setup URL it prints.</p><a class="button" href="/auth/setup">Open setup</a></div>
{{end}}
</main>
{{if .Active}}<script>
const form = document.getElementById('oauth-form');
const button = document.getElementById('passkey-button');
const errorBox = document.getElementById('passkey-error');
const fromB64 = value => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const toB64 = value => {
  const bytes = new Uint8Array(value);
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const assertionJSON = credential => ({
  id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
  authenticatorAttachment: credential.authenticatorAttachment,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    authenticatorData: toB64(credential.response.authenticatorData),
    clientDataJSON: toB64(credential.response.clientDataJSON),
    signature: toB64(credential.response.signature),
    userHandle: credential.response.userHandle ? toB64(credential.response.userHandle) : null
  }
});
async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Authentication failed');
  return data;
}
button.addEventListener('click', async () => {
  button.disabled = true; errorBox.hidden = true;
  try {
    if (!window.PublicKeyCredential) throw new Error('Passkeys are not supported in this browser.');
    const options = await jsonRequest('/auth/passkey/begin', {method:'POST'});
    options.publicKey.challenge = fromB64(options.publicKey.challenge);
    for (const item of options.publicKey.allowCredentials || []) item.id = fromB64(item.id);
    const credential = await navigator.credentials.get({publicKey: options.publicKey});
    await jsonRequest('/auth/passkey/finish', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(assertionJSON(credential))});
    const method = document.createElement('input'); method.type = 'hidden'; method.name = 'method'; method.value = 'passkey'; form.append(method);
    form.submit();
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : 'Authentication failed';
    errorBox.hidden = false; button.disabled = false;
  }
});
</script>{{end}}</body></html>`

const setupUnlockPageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up authentication · JustTerminal</title><style>` + authPageStyle + `</style></head>
<body><main class="card"><h1 class="brand">Set up authentication</h1>
<p class="lede">Enter the single-use code created locally on the JustTerminal host.</p>
<form method="post" action="/auth/setup/unlock" class="stack">
<label>Setup code<input name="code" required autocomplete="off" spellcheck="false" autofocus></label>
<button type="submit">Unlock setup</button>
</form><p class="muted" style="margin-top:18px">Generate a code with <code>just-terminal auth init</code>. Codes expire after ten minutes.</p>
</main></body></html>`

const setupEnrollmentPageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enroll authentication · JustTerminal</title><style>` + authPageStyle + `</style></head>
<body><main class="card"><h1 class="brand">Secure JustTerminal</h1>
<p class="lede">Register a passkey, then confirm an authenticator app. Authentication activates only after both steps succeed.</p>
<section id="passkey-step" class="stack"><strong>1. Register a passkey</strong><button id="register-passkey">Register passkey</button></section>
<section id="totp-step" class="stack" hidden><strong>2. Add an authenticator</strong><img id="totp-qr" class="qr" alt="Authenticator QR code"><p class="muted">If you cannot scan the QR code, enter this secret manually:</p><code id="totp-secret" class="secret"></code><label>Six-digit code<input id="totp-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label><button id="confirm-totp">Confirm and activate</button></section>
<section id="recovery-step" class="stack" hidden><strong class="success">Authentication is active</strong><p class="muted">Save these one-use recovery codes now. They will not be shown again. Browser recovery requires one code plus your authenticator.</p><pre id="recovery-codes"></pre><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><button id="copy-codes" class="secondary">Copy</button><button id="download-codes" class="secondary">Download</button></div><a class="button" href="/">Continue to JustTerminal</a></section>
<p id="setup-error" class="error" role="alert" hidden></p>
</main><script>
const passkeyStep = document.getElementById('passkey-step');
const totpStep = document.getElementById('totp-step');
const recoveryStep = document.getElementById('recovery-step');
const errorBox = document.getElementById('setup-error');
const registerButton = document.getElementById('register-passkey');
const confirmButton = document.getElementById('confirm-totp');
let recoveryText = '';
const fromB64 = value => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const toB64 = value => {
  const bytes = new Uint8Array(value); let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const registrationJSON = credential => ({
  id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
  authenticatorAttachment: credential.authenticatorAttachment,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    attestationObject: toB64(credential.response.attestationObject),
    clientDataJSON: toB64(credential.response.clientDataJSON),
    transports: credential.response.getTransports ? credential.response.getTransports() : []
  }
});
async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Setup failed');
  return data;
}
function showError(error) { errorBox.textContent = error instanceof Error ? error.message : 'Setup failed'; errorBox.hidden = false; }
registerButton.addEventListener('click', async () => {
  registerButton.disabled = true; errorBox.hidden = true;
  try {
    if (!window.PublicKeyCredential) throw new Error('Passkeys are not supported in this browser.');
    const options = await jsonRequest('/auth/setup/passkey/begin', {method:'POST'});
    options.publicKey.challenge = fromB64(options.publicKey.challenge);
    options.publicKey.user.id = fromB64(options.publicKey.user.id);
    for (const item of options.publicKey.excludeCredentials || []) item.id = fromB64(item.id);
    const credential = await navigator.credentials.create({publicKey: options.publicKey});
    await jsonRequest('/auth/setup/passkey/finish', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(registrationJSON(credential))});
    const totp = await jsonRequest('/auth/setup/totp/begin', {method:'POST'});
    document.getElementById('totp-qr').src = totp.qr;
    document.getElementById('totp-secret').textContent = totp.secret;
    passkeyStep.hidden = true; totpStep.hidden = false; document.getElementById('totp-code').focus();
  } catch (error) { showError(error); registerButton.disabled = false; }
});
confirmButton.addEventListener('click', async () => {
  confirmButton.disabled = true; errorBox.hidden = true;
  try {
    const code = document.getElementById('totp-code').value;
    const result = await jsonRequest('/auth/setup/totp/finish', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    recoveryText = result.recoveryCodes.join('\n');
    document.getElementById('recovery-codes').textContent = recoveryText;
    totpStep.hidden = true; recoveryStep.hidden = false;
  } catch (error) { showError(error); confirmButton.disabled = false; }
});
document.getElementById('copy-codes').addEventListener('click', async () => { await navigator.clipboard.writeText(recoveryText); });
document.getElementById('download-codes').addEventListener('click', () => {
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([recoveryText + '\n'], {type:'text/plain'})); link.download = 'just-terminal-recovery-codes.txt'; link.click(); URL.revokeObjectURL(link.href);
});
</script></body></html>`

const setupCompletePageHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authentication active · JustTerminal</title><style>` + authPageStyle + `</style></head>
<body><main class="card"><h1 class="brand">Authentication is active</h1><p class="lede">This host already has an enrolled passkey and authenticator.</p><a class="button" href="/">Continue to JustTerminal</a></main></body></html>`
