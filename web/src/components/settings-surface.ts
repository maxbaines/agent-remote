import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { FONT_FAMILIES } from '../lib/fonts.js';
import type { ResolvedConfig } from '../lib/config.js';
import {
  DEFAULT_AI_STATUS,
  saveAIKey,
  clearAIKey,
  pingAI,
  type AIStatus,
} from '../lib/ai.js';

/**
 * mux-settings-surface — Phase 5 two-column settings panel.
 *
 * Layout: narrow sidebar (Appearance / Notifications) + content area.
 * Changes apply immediately and are persisted via the parent's PATCH call.
 *
 * Events:
 *   config-change  { config: ResolvedConfig }  — emitted on every user change
 *   close                                       — emitted when × is clicked
 */
@customElement('mux-settings-surface')
export class MuxSettingsSurface extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* ── Header bar ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      border-bottom: 1px solid var(--chrome-border);
      flex-shrink: 0;
    }

    .header h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--chrome-text-bright);
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 3px 7px;
      border-radius: 4px;
      transition: color 0.1s, background 0.1s;
    }
    .close-btn:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }

    /* ── Body: sidebar + content ── */
    .body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: 156px;
      flex-shrink: 0;
      border-right: 1px solid var(--chrome-border);
      padding: 12px 0;
      overflow-y: auto;
    }

    .sidebar-item {
      display: block;
      width: 100%;
      padding: 9px 18px;
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      color: var(--chrome-text-dim);
      text-align: left;
      border-radius: 0;
      transition: color 0.1s, background 0.1s;
    }
    .sidebar-item:hover {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }
    .sidebar-item.active {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
      font-weight: 500;
    }

    /* ── Content area ── */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 28px 40px;
    }

    /* ── Section headings ── */
    .section-title {
      margin: 0 0 16px 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--chrome-text-dim);
    }

    .section-gap {
      margin-top: 32px;
    }

    /* ── Font family radios ── */
    .font-radios {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .font-radio-label {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .font-radio-label:hover {
      background: var(--chrome-hover);
    }

    .font-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
      width: 14px;
      height: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .font-radio-name {
      flex: 1;
      color: var(--chrome-text-bright);
    }

    /* ── Font size slider ── */
    .size-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      margin-top: 4px;
    }

    .size-label {
      color: var(--chrome-text-dim);
      width: 64px;
      flex-shrink: 0;
    }

    input[type="range"] {
      flex: 1;
      accent-color: var(--chrome-accent);
      height: 4px;
      cursor: pointer;
    }

    .size-value {
      width: 28px;
      text-align: right;
      color: var(--chrome-text-bright);
      font-feature-settings: 'tnum';
    }

    /* ── Font preview line ── */
    .font-preview {
      margin: 10px 0 0 10px;
      padding: 8px 12px;
      background: var(--chrome-bar);
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      font-size: 12px;
      color: var(--chrome-text-bright);
      overflow: hidden;
      white-space: nowrap;
    }

    /* ── Notifications section ── */
    .notif-block {
      max-width: 480px;
    }

    .notif-description {
      color: var(--chrome-text-dim);
      line-height: 1.55;
      margin: 0 0 14px 0;
    }

    .notif-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid var(--chrome-accent);
      background: transparent;
      color: var(--chrome-accent);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .notif-btn:hover {
      background: var(--chrome-accent);
      color: var(--chrome-body);
    }

    .notif-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--chrome-text-dim);
      font-size: 13px;
    }
    .notif-status.granted {
      color: var(--mux-ok);
    }
    .notif-status.denied {
      color: var(--chrome-danger);
    }

    .notif-help-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 11px;
      color: var(--chrome-accent);
      text-decoration: none;
    }
    .notif-help-link:hover {
      text-decoration: underline;
    }

    .notif-hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--chrome-text-dim);
      line-height: 1.5;
    }

    .notif-test-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 6px;
      border: 1px solid var(--chrome-border);
      background: transparent;
      color: var(--chrome-text-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .notif-test-btn:hover {
      border-color: var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    .divider {
      height: 1px;
      background: var(--chrome-border);
      margin: 22px 0;
    }

    /* ── Bell radios ── */
    .bell-radios {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .bell-radio-label {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .bell-radio-label:hover {
      background: var(--chrome-hover);
    }

    .bell-radio-label input[type="radio"] {
      accent-color: var(--chrome-accent);
      width: 14px;
      height: 14px;
      margin-top: 1px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .bell-radio-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .bell-radio-name {
      color: var(--chrome-text-bright);
    }

    .bell-radio-desc {
      font-size: 11px;
      color: var(--chrome-text-dim);
    }

    /* ── AI section ── */
    .ai-status {
      margin: 0 0 12px;
      color: var(--chrome-text-bright);
    }

    .ai-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 13px;
      color: var(--chrome-text-bright);
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border, #444);
      border-radius: 4px;
    }

    .ai-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .ai-actions button {
      padding: 5px 12px;
      font-family: inherit;
      font-size: 12px;
      color: var(--chrome-text-bright);
      background: var(--chrome-body);
      border: 1px solid var(--chrome-border, #444);
      border-radius: 4px;
      cursor: pointer;
    }

    .ai-actions button[disabled] {
      opacity: 0.5;
      cursor: default;
    }

    .ai-message {
      margin-top: 10px;
      font-size: 12px;
      color: var(--chrome-text-dim);
    }

    .ai-note {
      margin-top: 16px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--chrome-text-dim);
    }
  `;

  @property({ attribute: false }) config: ResolvedConfig | null = null;
  @property({ type: String }) serverAddr = '';
  @property({ attribute: false }) aiStatus: AIStatus = DEFAULT_AI_STATUS;

  @state() private _section: 'appearance' | 'notifications' | 'ai' = 'appearance';
  @state() private _notifPermission: NotificationPermission | 'unsupported' = 'default';
  @state() private _notifRequesting = false;
  @state() private _aiKeyInput = '';
  @state() private _aiBusy = false;
  @state() private _aiMessage = '';

  override connectedCallback(): void {
    super.connectedCallback();
    this._refreshNotifPermission();
  }

  private _refreshNotifPermission(): void {
    if (!('Notification' in window)) {
      this._notifPermission = 'unsupported';
    } else {
      this._notifPermission = Notification.permission;
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _emit(partial: Partial<ResolvedConfig>): void {
    if (!this.config) return;
    const next: ResolvedConfig = { ...this.config, ...partial };
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: { config: next },
      bubbles: true,
      composed: true,
    }));
  }

  private _setFontFamily(family: string): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, family } });
  }

  private _setFontSize(size: number): void {
    if (!this.config) return;
    this._emit({ font: { ...this.config.font, size } });
  }

  private _setBell(bell: ResolvedConfig['terminal']['bell']): void {
    if (!this.config) return;
    this._emit({ terminal: { ...this.config.terminal, bell } });
  }

  private _sendTestNotification(): void {
    try {
      new Notification('Agent Remote', {
        body: 'Notifications are working! You\'ll see this when a terminal bell fires in a background pane.',
        tag: 'agent-remote-test',
        silent: false,
      });
    } catch (e) {
      console.error('agent-remote: test notification failed:', e);
    }
  }

  private async _requestNotificationPermission(): Promise<void> {
    if (this._notifRequesting) return;
    this._notifRequesting = true;
    try {
      const result = await Notification.requestPermission();
      this._notifPermission = result;
    } catch {
      this._notifPermission = 'unsupported';
    } finally {
      this._notifRequesting = false;
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  private _renderFontPicker() {
    const cfg = this.config;
    if (!cfg) return html``;
    const family = cfg.font.family;
    const size = cfg.font.size;

    return html`
      <div class="font-radios">
        ${FONT_FAMILIES.map(f => html`
          <label class="font-radio-label">
            <input
              type="radio"
              name="font-family"
              .checked="${family === f.id}"
              @change="${() => this._setFontFamily(f.id)}"
            />
            <span class="font-radio-name" style="font-family:'${f.id}',monospace">${f.label}</span>
          </label>
        `)}
      </div>
      <div class="size-row">
        <span class="size-label">Size</span>
        <input
          type="range"
          min="8" max="24" step="1"
          .value="${String(size)}"
          @input="${(e: Event) => {
            const v = parseInt((e.target as HTMLInputElement).value, 10);
            this._setFontSize(v);
          }}"
        />
        <span class="size-value">${size}</span>
      </div>
      <div
        class="font-preview"
        style="font-family:'${family}',monospace;font-size:${size}px"
      >The quick brown fox jumps $ █</div>
    `;
  }

  private _renderNotifPermission() {
    const perm = this._notifPermission;

    if (perm === 'unsupported') {
      return html`
        <p class="notif-description">
          Desktop notifications are not supported in this browser.
        </p>
      `;
    }

    if (perm === 'granted') {
      return html`
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="notif-status granted">✓ Desktop Notifications: Enabled</span>
          <button class="notif-test-btn" @click="${() => this._sendTestNotification()}">
            Send test notification
          </button>
        </div>
        <p class="notif-hint" style="margin-top:8px">
          Notifications appear when a bell fires in a background pane.
          If the test notification doesn't appear, check
          <strong>System Settings → Notifications → [your browser]</strong>
          and make sure "Allow Notifications" is on. macOS Focus / Do Not Disturb
          also suppresses them.
        </p>
      `;
    }

    if (perm === 'denied') {
      return html`
        <span class="notif-status denied">
          Blocked by browser — update in browser settings
        </span>
        <br>
        <a
          class="notif-help-link"
          href="https://support.google.com/chrome/answer/3220216"
          target="_blank"
          rel="noopener noreferrer"
        >How to re-enable notifications →</a>
      `;
    }

    // default: not yet requested (or dismissed without choosing)
    return html`
      <button
        class="notif-btn"
        ?disabled="${this._notifRequesting}"
        @click="${() => this._requestNotificationPermission()}"
      >${this._notifRequesting ? 'Waiting for browser…' : 'Enable Desktop Notifications'}</button>
      ${this._notifRequesting ? html`
        <p class="notif-hint">
          Look for a permission prompt in your browser's address bar or toolbar.
        </p>
      ` : ''}
    `;
  }

  private _renderAppearance() {
    const cfg = this.config;
    if (!cfg) return html``;
    return html`
      <p class="section-title">Terminal Font</p>
      ${this._renderFontPicker()}
    `;
  }

  private _renderNotifications() {
    const cfg = this.config;
    if (!cfg) return html``;
    const bell = cfg.terminal.bell;

    return html`
      <div class="notif-block">
        <p class="section-title">Desktop Alerts</p>
        <p class="notif-description">
          Allow Agent Remote to send desktop notifications when a Terminal Session needs your attention.
        </p>
        ${this._renderNotifPermission()}
      </div>

      <div class="divider"></div>

      <p class="section-title">Bell</p>
      <div class="bell-radios">
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'visual'}"
            @change="${() => this._setBell('visual')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Visual</span>
            <span class="bell-radio-desc">Flash the pane tab</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'audible'}"
            @change="${() => this._setBell('audible')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Audible</span>
            <span class="bell-radio-desc">Play the system bell sound</span>
          </div>
        </label>
        <label class="bell-radio-label">
          <input
            type="radio"
            name="bell"
            .checked="${bell === 'off'}"
            @change="${() => this._setBell('off')}"
          />
          <div class="bell-radio-text">
            <span class="bell-radio-name">Off</span>
            <span class="bell-radio-desc">Silence all bell events</span>
          </div>
        </label>
      </div>
    `;
  }

  private _emitAIStatus(status: AIStatus): void {
    this.aiStatus = status;
    this.dispatchEvent(new CustomEvent('ai-status-change', {
      detail: { status },
      bubbles: true,
      composed: true,
    }));
  }

  private async _saveAIKey(): Promise<void> {
    const key = this._aiKeyInput.trim();
    if (!key || this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = '';
    try {
      this._emitAIStatus(await saveAIKey(key));
      this._aiKeyInput = '';
      this._aiMessage = 'Key saved.';
    } catch {
      this._aiMessage = 'Could not save the key -- it was not stored.';
    } finally {
      this._aiBusy = false;
    }
  }

  private async _removeAIKey(): Promise<void> {
    if (this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = '';
    try {
      this._emitAIStatus(await clearAIKey());
      this._aiKeyInput = '';
      this._aiMessage = 'Key removed.';
    } catch {
      this._aiMessage = 'Could not remove the key.';
    } finally {
      this._aiBusy = false;
    }
  }

  private async _testAI(): Promise<void> {
    if (this._aiBusy) return;
    this._aiBusy = true;
    this._aiMessage = 'Testing...';
    try {
      const res = await pingAI();
      this._aiMessage = res.ok
        ? 'Connected to Anthropic.'
        : res.error === 'ai_disabled'
          ? 'AI is off -- save a key first.'
          : res.error === 'provider_unreachable'
            ? 'Could not reach Anthropic. Check your connection.'
            : 'Anthropic rejected the request. Check the key.';
    } catch {
      this._aiMessage = 'Test failed -- check your connection.';
    } finally {
      this._aiBusy = false;
    }
  }

  private _renderAI() {
    const st = this.aiStatus;
    return html`
      <p class="section-title">Anthropic API Key</p>
      <p class="ai-status">
        ${st.enabled
          ? `AI enabled -- key ending ${st.keyHint} (from ${st.source}).`
          : 'AI features are off -- add an Anthropic API key to enable.'}
      </p>
      <input
        class="ai-input"
        type="password"
        autocomplete="off"
        placeholder="sk-ant-..."
        .value="${this._aiKeyInput}"
        @input="${(e: Event) => { this._aiKeyInput = (e.target as HTMLInputElement).value; }}"
      />
      <div class="ai-actions">
        <button
          ?disabled="${this._aiBusy || this._aiKeyInput.trim() === ''}"
          @click="${this._saveAIKey}"
        >Save</button>
        ${st.source === 'settings'
          ? html`<button ?disabled="${this._aiBusy}" @click="${this._removeAIKey}">Remove</button>`
          : ''}
        <button ?disabled="${this._aiBusy}" @click="${this._testAI}">Test connection</button>
      </div>
      ${this._aiMessage ? html`<p class="ai-message">${this._aiMessage}</p>` : ''}
      <p class="ai-note">
        The key is stored locally at <code>$XDG_CONFIG_HOME/agent-remote/anthropic_key</code>
        (defaults to <code>~/.config/agent-remote/anthropic_key</code> when
        <code>XDG_CONFIG_HOME</code> is unset) with owner-only permissions, is
        never returned by the server, and is sent only to Anthropic.
      </p>
    `;
  }

  override render() {
    if (!this.config) return html``;

    return html`
      <div class="header">
        <h2>Settings</h2>
        <button class="close-btn" title="Close" @click="${this._close}">×</button>
      </div>
      <div class="body">
        <nav class="sidebar">
          <button
            class="sidebar-item ${this._section === 'appearance' ? 'active' : ''}"
            @click="${() => { this._section = 'appearance'; }}"
          >Appearance</button>
          <button
            class="sidebar-item ${this._section === 'notifications' ? 'active' : ''}"
            @click="${() => { this._section = 'notifications'; }}"
          >Notifications</button>
          <button
            class="sidebar-item ${this._section === 'ai' ? 'active' : ''}"
            @click="${() => { this._section = 'ai'; }}"
          >AI</button>
        </nav>
        <div class="content">
          ${this._section === 'appearance'
            ? this._renderAppearance()
            : this._section === 'notifications'
              ? this._renderNotifications()
              : this._renderAI()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-settings-surface': MuxSettingsSurface;
  }
}
