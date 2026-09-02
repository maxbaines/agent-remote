import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

interface TunnelInfo {
  id: string;
  port: number;
  url: string;
}

@customElement('mux-local-apps-settings')
export class MuxLocalAppsSettings extends LitElement {
  static styles = css`
    :host {
      display: block;
      max-width: 680px;
      color: var(--chrome-text-bright);
    }

    .section-title {
      margin: 0 0 10px;
      color: var(--chrome-text-dim);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .description {
      max-width: 590px;
      margin: 0 0 18px;
      color: var(--chrome-text-dim);
      line-height: 1.55;
    }

    .expose-form {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 390px;
      margin-bottom: 22px;
    }

    .port-field {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      overflow: hidden;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
    }

    .port-field:focus-within {
      border-color: var(--chrome-accent);
    }

    .port-prefix {
      padding-left: 11px;
      color: var(--chrome-text-dim);
      user-select: none;
    }

    .port-input {
      width: 100%;
      min-width: 0;
      padding: 8px 10px 8px 3px;
      color: var(--chrome-text-bright);
      background: transparent;
      border: 0;
      outline: 0;
      font: inherit;
      font-variant-numeric: tabular-nums;
    }

    .port-input::placeholder {
      color: var(--chrome-text-dim);
    }

    .primary-btn,
    .secondary-btn {
      border-radius: 6px;
      font: inherit;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s, background 0.12s;
    }

    .primary-btn {
      padding: 8px 14px;
      color: var(--chrome-body);
      background: var(--chrome-accent);
      border: 1px solid var(--chrome-accent);
      font-weight: 600;
    }

    .primary-btn:hover:not(:disabled) {
      filter: brightness(1.08);
    }

    .primary-btn:disabled,
    .secondary-btn:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .list-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 9px;
    }

    .list-heading .section-title {
      margin: 0;
    }

    .refresh-btn {
      padding: 3px 0;
      color: var(--chrome-text-dim);
      background: transparent;
      border: 0;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    .refresh-btn:hover:not(:disabled) {
      color: var(--chrome-text-bright);
    }

    .tunnel-list {
      overflow: hidden;
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
    }

    .tunnel-row {
      display: grid;
      grid-template-columns: minmax(82px, auto) minmax(0, 1fr);
      align-items: center;
      gap: 14px;
      padding: 11px 12px;
      background: var(--chrome-bar);
    }

    .tunnel-row + .tunnel-row {
      border-top: 1px solid var(--chrome-border);
    }

    .port {
      color: var(--chrome-text-bright);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    .registered {
      display: block;
      margin-top: 2px;
      color: var(--mux-ok);
      font-size: 10px;
      font-weight: 400;
    }

    .path {
      overflow: hidden;
      color: var(--chrome-text-dim);
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: flex;
      grid-column: 1 / -1;
      justify-content: flex-end;
      gap: 6px;
    }

    .secondary-btn {
      padding: 5px 9px;
      color: var(--chrome-text-dim);
      background: transparent;
      border: 1px solid var(--chrome-border);
      text-decoration: none;
    }

    .secondary-btn:hover:not(:disabled) {
      color: var(--chrome-text-bright);
      border-color: var(--chrome-accent);
    }

    .secondary-btn.danger:hover:not(:disabled) {
      color: var(--chrome-danger);
      border-color: var(--chrome-danger);
    }

    .empty,
    .loading {
      padding: 18px 14px;
      color: var(--chrome-text-dim);
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 8px;
      text-align: center;
    }

    .error {
      margin: -10px 0 16px;
      color: var(--chrome-danger);
      font-size: 12px;
      line-height: 1.45;
    }

    .notice {
      margin-top: 18px;
      padding: 11px 13px;
      color: var(--chrome-text-dim);
      background: color-mix(in srgb, var(--chrome-accent) 7%, transparent);
      border: 1px solid var(--chrome-border);
      border-radius: 7px;
      font-size: 11px;
      line-height: 1.55;
    }

    .notice strong {
      color: var(--chrome-text-bright);
      font-weight: 600;
    }

  `;

  @state() private _tunnels: TunnelInfo[] = [];
  @state() private _port = '';
  @state() private _loading = true;
  @state() private _creating = false;
  @state() private _closingId: string | null = null;
  @state() private _copiedId: string | null = null;
  @state() private _error = '';

  override connectedCallback(): void {
    super.connectedCallback();
    void this._refresh();
  }

  private _tunnelOrigin(tunnel: TunnelInfo): string {
    try {
      return new URL(tunnel.url).origin;
    } catch {
      return tunnel.url;
    }
  }

  private _sortTunnels(tunnels: TunnelInfo[]): TunnelInfo[] {
    return [...tunnels].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
  }

  private async _responseError(response: Response): Promise<string> {
    const body = (await response.text()).trim();
    return body || `Request failed (${response.status})`;
  }

  private async _refresh(): Promise<void> {
    this._loading = true;
    this._error = '';
    try {
      const response = await fetch('/api/tunnels');
      if (!response.ok) throw new Error(await this._responseError(response));
      const tunnels = await response.json() as TunnelInfo[];
      this._tunnels = this._sortTunnels(tunnels);
    } catch (error) {
      this._error = error instanceof Error ? error.message : 'Could not load local apps';
    } finally {
      this._loading = false;
    }
  }

  private async _create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this._creating) return;

    const port = Number(this._port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this._error = 'Enter a port between 1 and 65535.';
      return;
    }

    this._creating = true;
    this._error = '';
    try {
      const response = await fetch('/api/tunnels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (!response.ok) throw new Error(await this._responseError(response));
      const tunnel = await response.json() as TunnelInfo;
      this._tunnels = this._sortTunnels([
        ...this._tunnels.filter((entry) => entry.id !== tunnel.id),
        tunnel,
      ]);
      this._port = '';
    } catch (error) {
      this._error = error instanceof Error ? error.message : 'Could not expose local app';
    } finally {
      this._creating = false;
    }
  }

  private async _close(id: string): Promise<void> {
    if (this._closingId !== null) return;
    this._closingId = id;
    this._error = '';
    try {
      const response = await fetch(`/api/tunnels/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await this._responseError(response));
      this._tunnels = this._tunnels.filter((entry) => entry.id !== id);
    } catch (error) {
      this._error = error instanceof Error ? error.message : 'Could not stop exposing local app';
    } finally {
      this._closingId = null;
    }
  }

  private async _copy(tunnel: TunnelInfo): Promise<void> {
    this._error = '';
    try {
      await navigator.clipboard.writeText(tunnel.url);
      this._copiedId = tunnel.id;
      window.setTimeout(() => {
        if (this._copiedId === tunnel.id) this._copiedId = null;
      }, 1600);
    } catch {
      this._error = 'Could not copy the URL. Open the app and copy it from the address bar.';
    }
  }

  private _renderTunnels() {
    if (this._loading) return html`<div class="loading">Loading local apps…</div>`;
    if (this._tunnels.length === 0) {
      return html`<div class="empty">No local apps are exposed.</div>`;
    }

    return html`
      <div class="tunnel-list">
        ${this._tunnels.map((tunnel) => html`
          <div class="tunnel-row">
            <div class="port">
              :${tunnel.port}
              <span class="registered">Registered</span>
            </div>
            <div class="path" title="${this._tunnelOrigin(tunnel)}">
              ${this._tunnelOrigin(tunnel)}
            </div>
            <div class="actions">
              <a
                class="secondary-btn"
                href="${tunnel.url}"
                target="_blank"
                rel="noopener noreferrer"
              >Open</a>
              <button class="secondary-btn" @click="${() => this._copy(tunnel)}">
                ${this._copiedId === tunnel.id ? 'Copied' : 'Copy'}
              </button>
              <button
                class="secondary-btn danger"
                ?disabled="${this._closingId !== null}"
                @click="${() => this._close(tunnel.id)}"
              >${this._closingId === tunnel.id ? 'Stopping…' : 'Stop'}</button>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  override render() {
    return html`
      <p class="section-title">Expose a port</p>
      <p class="description">
        Reach a web app running on this JustTerminal host through the current browser URL.
      </p>
      <form class="expose-form" @submit="${this._create}">
        <label class="port-field">
          <span class="port-prefix">:</span>
          <input
            class="port-input"
            type="number"
            min="1"
            max="65535"
            step="1"
            inputmode="numeric"
            placeholder="5173"
            aria-label="Local app port"
            .value="${this._port}"
            @input="${(event: Event) => {
              this._port = (event.target as HTMLInputElement).value;
            }}"
          />
        </label>
        <button class="primary-btn" type="submit" ?disabled="${this._creating}">
          ${this._creating ? 'Exposing…' : 'Expose'}
        </button>
      </form>

      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : ''}

      <div class="list-heading">
        <p class="section-title">Exposed apps</p>
        <button class="refresh-btn" ?disabled="${this._loading}" @click="${this._refresh}">
          ${this._loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      ${this._renderTunnels()}

      <div class="notice">
        Registrations are cleared when the Gateway restarts. Each app opens at the root of its own
        wildcard hostname, so root assets, APIs, cookies, and WebSockets work normally. Only expose
        apps you trust.
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-local-apps-settings': MuxLocalAppsSettings;
  }
}
