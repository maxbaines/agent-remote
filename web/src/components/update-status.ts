import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Download, RefreshCw } from 'lucide';
import { icon } from '../lib/icons.js';
import {
  applyUpdate,
  fetchUpdateStatus,
  UpdateEndpointMissingError,
  type UpdateStatus,
} from '../lib/update.js';

const UPDATE_POLL_INTERVAL_MS = 2_000;
const UPDATE_POLL_MAX_ATTEMPTS = 30;
type UpdatePhase = 'checking' | 'idle' | 'updating' | 'failed';

/** Version and update controls shown on demand inside the About dialog. */
@customElement('mux-update-status')
export class MuxUpdateStatus extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--chrome-border);
      color: var(--chrome-text-dim);
      font-size: 13px;
    }

    .version-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
    }

    .label {
      color: var(--chrome-text-bright);
      font-weight: 600;
    }

    .version {
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      color: var(--chrome-text-bright);
    }

    .message {
      margin-top: 7px;
      line-height: 1.5;
    }

    .error { color: var(--chrome-danger); }

    button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 12px;
      padding: 7px 11px;
      border: 1px solid var(--chrome-accent);
      border-radius: 6px;
      background: transparent;
      color: var(--chrome-accent);
      cursor: pointer;
      font: inherit;
    }

    button:hover { background: var(--chrome-hover); }
    button:focus-visible { outline: 2px solid var(--chrome-accent); outline-offset: 2px; }
    button:disabled {
      border-color: var(--chrome-border);
      color: var(--chrome-text-dim);
      cursor: default;
      opacity: 0.65;
    }
    button:disabled:hover { background: transparent; }
    .lucide-icon { pointer-events: none; }
  `;

  @state() private _status: UpdateStatus | null = null;
  @state() private _phase: UpdatePhase = 'checking';
  @state() private _error = '';

  private _pollTimer: number | null = null;
  private _pollAttempts = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._check();
  }

  override disconnectedCallback(): void {
    this._clearPoll();
    super.disconnectedCallback();
  }

  private async _check(): Promise<void> {
    this._phase = 'checking';
    this._error = '';
    try {
      this._status = await fetchUpdateStatus();
      this._phase = 'idle';
    } catch (error: unknown) {
      this._phase = 'failed';
      this._error = error instanceof Error ? error.message : String(error);
    }
  }

  private _apply(): void {
    if (this._phase === 'updating') return;
    const previousVersion = this._status?.currentVersion ?? '';
    this._phase = 'updating';
    this._error = '';
    this._pollAttempts = 0;
    void applyUpdate()
      .then(() => { this._schedulePoll(previousVersion); })
      .catch((error: unknown) => {
        this._phase = 'failed';
        this._error = error instanceof Error ? error.message : String(error);
      });
  }

  private _retry(): void {
    if (this._status?.canUpdate) {
      this._apply();
      return;
    }
    void this._check();
  }

  private _clearPoll(): void {
    if (this._pollTimer !== null) {
      window.clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private _schedulePoll(previousVersion: string): void {
    this._clearPoll();
    this._pollTimer = window.setTimeout(() => {
      this._pollTimer = null;
      void this._pollForRestart(previousVersion);
    }, UPDATE_POLL_INTERVAL_MS);
  }

  private async _pollForRestart(previousVersion: string): Promise<void> {
    if (!this.isConnected || this._phase !== 'updating') return;
    this._pollAttempts++;
    try {
      const status = await fetchUpdateStatus();
      if (status.currentVersion !== '' && status.currentVersion !== previousVersion) {
        window.location.reload();
        return;
      }
    } catch (error: unknown) {
      if (error instanceof UpdateEndpointMissingError) {
        window.location.reload();
        return;
      }
    }
    if (!this.isConnected || this._phase !== 'updating') return;
    if (this._pollAttempts >= UPDATE_POLL_MAX_ATTEMPTS) {
      this._phase = 'failed';
      this._error = 'Update did not complete in time';
      return;
    }
    this._schedulePoll(previousVersion);
  }

  private _message(status: UpdateStatus): string {
    if (status.devBuild) return status.reason || 'Development build';
    if (status.method === 'container') return status.reason || 'Updates are managed by the container image.';
    if (status.updateAvailable && !status.canUpdate) return status.reason || 'An update is available through your package manager.';
    if (status.error) return 'Update check unavailable';
    return 'Up to date';
  }

  override render() {
    const status = this._status;
    return html`
      <div class="version-row">
        <span class="label">Version</span>
        <span class="version">${status?.currentVersion || 'unknown'}</span>
      </div>
      ${this._phase === 'checking'
        ? html`<div class="message">Checking for updates…</div>`
        : this._phase === 'updating'
          ? html`
              <div class="message">Downloading, verifying, and restarting…</div>
              <button disabled>${icon(Download, { size: 14 })}Updating…</button>
            `
          : this._phase === 'failed'
            ? html`
                <div class="message error">${this._error || 'Update failed'}</div>
                <button @click="${() => this._retry()}">
                  ${icon(RefreshCw, { size: 14 })}Retry
                </button>
              `
            : status?.canUpdate
              ? html`
                  <div class="message">Version ${status.latestVersion} is available.</div>
                  <button @click="${() => this._apply()}">
                    ${icon(Download, { size: 14 })}Update to ${status.latestVersion}
                  </button>
                `
              : status
                ? html`<div class="message">${this._message(status)}</div>`
                : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-update-status': MuxUpdateStatus;
  }
}
