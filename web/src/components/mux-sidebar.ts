import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { store } from '../state.js';
import { workspaceLabel } from './workspace-picker.js';
import './launcher-menu.js';
import { icon } from '../lib/icons.js';
import { Bot, Check, Ellipsis, Plus } from 'lucide';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/sidebar-width.js';
import { instanceLabel } from '../lib/instance-identity.js';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { acknowledgeCodexDefault } from '../lib/codex.js';

interface CodexTerminalHint {
  contextUsed?: number;
  question?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('mux-sidebar')
export class MuxSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--chrome-bar);
      border-right: 1px solid var(--chrome-border);
      min-width: ${unsafeCSS(String(SIDEBAR_MIN_WIDTH))}px;
      max-width: ${unsafeCSS(String(SIDEBAR_MAX_WIDTH))}px;
      height: 100%;
      position: relative;
      overflow: hidden;
      user-select: none;
      box-sizing: border-box;
      flex-shrink: 0;
    }

    .header {
      min-height: 36px;
      padding: 0 10px 0 12px;
      font-size: 13.5px;
      font-weight: 700;
      color: var(--chrome-text-bright);
      letter-spacing: 0.045em;
      border-bottom: 1px solid var(--chrome-border);
      background: var(--chrome-bar);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header > span {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .launcher-btn {
      width: 26px;
      height: 22px;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--chrome-text-bright);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }

    .launcher-btn:hover {
      background: var(--chrome-hover);
    }

    .launcher-btn:disabled {
      color: var(--chrome-text-dim);
      cursor: not-allowed;
      opacity: 0.45;
    }

    .launcher-btn:disabled:hover {
      background: transparent;
    }

    .launcher-btn.active {
      color: var(--chrome-accent);
      background: var(--chrome-hover);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1px;
      flex-shrink: 0;
    }

    .menu-anchor {
      position: absolute;
      top: 38px;
      left: 8px;
      z-index: 1500;
    }

    .lucide-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
      pointer-events: none;
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 7px 0;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--chrome-text-dim) 32%, transparent) transparent;
    }

    /* ---- workspace cards ---- */

    .ws-card {
      position: relative;
      padding: 7px 10px 8px;
      margin: 2px 6px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s, border-color 0.12s, opacity 0.2s;
    }

    .ws-card:hover {
      background: var(--chrome-hover);
    }

    .ws-card.active {
      border-color: color-mix(in srgb, var(--chrome-accent) 82%, white);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--chrome-accent) 18%, transparent);
    }

    .ws-card.active::before {
      content: '';
      position: absolute;
      top: 7px;
      bottom: 7px;
      left: 2px;
      width: 2px;
      border-radius: 2px;
      background: var(--mux-warn);
      box-shadow: 0 0 5px color-mix(in srgb, var(--mux-warn) 45%, transparent);
    }

    .ws-card.pending-close {
      opacity: 0.35;
      pointer-events: none;
    }

    .ws-card.codex {
      padding: 9px 10px 10px;
      border-color: color-mix(in srgb, var(--chrome-accent) 30%, transparent);
      background: color-mix(in srgb, var(--chrome-accent) 7%, var(--chrome-bar));
    }

    .ws-card.codex.active {
      border-color: color-mix(in srgb, var(--chrome-accent) 82%, white);
      background: color-mix(in srgb, var(--chrome-accent) 7%, var(--chrome-bar));
    }

    .codex-kicker {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      margin-bottom: 5px;
      color: color-mix(in srgb, var(--chrome-accent) 65%, var(--chrome-text-bright));
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }


    .codex-kicker-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .codex-status {
      margin-left: auto;
      padding: 2px 5px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--mux-ok) 18%, transparent);
      color: var(--mux-ok);
      font-size: 9px;
      letter-spacing: 0.02em;
      text-transform: none;
      white-space: nowrap;
    }

    .codex-status.working {
      background: color-mix(in srgb, var(--chrome-accent) 20%, transparent);
      color: color-mix(in srgb, var(--chrome-accent) 55%, white);
    }

    .codex-status.attention {
      background: color-mix(in srgb, var(--mux-warn) 22%, transparent);
      color: var(--mux-warn);
    }


    .codex-title {
      color: var(--chrome-text-bright);
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }


    .codex-detail {
      margin-top: 5px;
      color: var(--chrome-text-dim);
      font-size: 10.5px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .codex-detail.attention {
      color: var(--mux-warn);
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .codex-attention-row { display: flex; align-items: center; gap: 7px; margin-top: 5px; }
    .codex-attention-row .codex-detail { flex: 1; min-width: 0; margin-top: 0; }
    .codex-ack-btn {
      width: 28px; height: 28px; display: inline-flex; align-items: center;
      justify-content: center; flex: 0 0 auto; padding: 0;
      border: 1px solid color-mix(in srgb, var(--mux-ok) 55%, transparent);
      border-radius: 7px; background: color-mix(in srgb, var(--mux-ok) 16%, var(--chrome-bar));
      color: var(--mux-ok); cursor: pointer; touch-action: manipulation;
    }
    .codex-ack-btn:hover { background: color-mix(in srgb, var(--mux-ok) 26%, var(--chrome-bar)); }
    .codex-ack-btn:disabled { opacity: 0.5; cursor: wait; }
    .codex-task-label {
      color: var(--chrome-text-dim); font-size: 9px; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 2px;
    }

    .ws-card.codex.active .codex-detail {
      color: rgba(255, 255, 255, 0.76);
    }

    .codex-context {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 7px;
      color: var(--chrome-text-dim);
      font-size: 9.5px;
    }

    .codex-context-track {
      flex: 1;
      height: 3px;
      overflow: hidden;
      border-radius: 999px;
      background: color-mix(in srgb, var(--chrome-text-dim) 22%, transparent);
    }

    .codex-context-fill {
      height: 100%;
      border-radius: inherit;
      background: var(--chrome-accent);
    }

    .ws-card.codex.active .codex-context {
      color: rgba(255, 255, 255, 0.7);
    }

    .ws-card.codex.active .codex-context-track {
      background: rgba(0, 0, 0, 0.2);
    }

    .ws-card.codex.active .codex-context-fill {
      background: white;
    }

    .ws-header {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .dot {
      font-size: 7px;
      flex-shrink: 0;
      line-height: 1;
    }

    .dot.active {
      color: white;
      text-shadow: 0 0 4px rgba(255, 255, 255, 0.45);
    }

    .dot.inactive {
      color: var(--chrome-text-dim);
    }

    .ws-name {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--chrome-text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .ws-card.active .ws-name {
      color: white;
      font-weight: 600;
    }

    .ws-rename-input {
      flex: 1;
      background: var(--chrome-body);
      border: 1px solid var(--chrome-accent);
      border-radius: 3px;
      color: var(--chrome-text-bright);
      font: inherit;
      font-size: 13px;
      padding: 1px 5px;
      outline: none;
      min-width: 0;
    }

    .ws-rename-input:focus {
      box-shadow: 0 0 0 2px var(--chrome-accent)33;
    }

    .ws-remove-btn {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--chrome-text-dim);
      cursor: pointer;
      padding: 1px 3px;
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s;
    }

    .ws-card:hover .ws-remove-btn,
    .ws-card.active .ws-remove-btn {
      opacity: 1;
    }

    .ws-remove-btn:hover {
      color: var(--chrome-danger);
    }

    .ws-card.active .ws-remove-btn {
      color: rgba(255, 255, 255, 0.72);
    }

    .ws-card.active .ws-remove-btn:hover {
      color: white;
      background: rgba(0, 0, 0, 0.16);
    }

    .ws-hint {
      font-size: 11px;
      color: var(--chrome-text-dim);
      margin-top: 2px;
      padding-left: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ws-card.active .ws-hint {
      color: rgba(255, 255, 255, 0.76);
    }
  `;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  @state() private _version = 0;
  @state() private _renaming: string | null = null;
  @state() private _pendingClose = new Set<string>();
  @state() private _menuOpen = false;
  @state() private _acknowledging = new Set<string>();

  private _unsub: (() => void) | null = null;
  private _codexTerminalHints = new Map<string, CodexTerminalHint>();

  private _onOutsideClick = (e: MouseEvent): void => {
    if (this._menuOpen && !e.composedPath().includes(this)) {
      this._menuOpen = false;
    }
  };

  private _onLauncherAction(e: Event): void {
    e.stopPropagation();
    this._menuOpen = false;
    const customEvent = e as CustomEvent;
    this.dispatchEvent(new CustomEvent('launcher-action', {
      bubbles: true,
      composed: true,
      detail: customEvent.detail,
    }));
  }


  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('mousedown', this._onOutsideClick);

    // Subscribe to store changes and trigger re-render by bumping _version.
    this._unsub = store.subscribe(() => {
      this._version++;
    });
  }

  override disconnectedCallback(): void {
    document.removeEventListener('mousedown', this._onOutsideClick);
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Remove a workspace from the pending-close set (called by the parent to restore). */
  restoreWorkspace(wsId: string): void {
    const next = new Set(this._pendingClose);
    next.delete(wsId);
    this._pendingClose = next;
  }

  // ---------------------------------------------------------------------------
  // Workspace helpers
  // ---------------------------------------------------------------------------

  private _onWsClick(wsId: string): void {
    store.ackWorkspace(wsId);
    this.dispatchEvent(
      new CustomEvent('workspace-switch', {
        detail: { workspaceId: wsId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewWs(): void {
    this.dispatchEvent(
      new CustomEvent('workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onNewCodex(): void {
    this.dispatchEvent(
      new CustomEvent('codex-workspace-create', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async _onCodexAcknowledge(e: Event, workspaceId: string): Promise<void> {
    e.stopPropagation();
    if (this._acknowledging.has(workspaceId)) return;
    this._acknowledging = new Set(this._acknowledging).add(workspaceId);
    try {
      await acknowledgeCodexDefault(workspaceId);
      store.ackWorkspace(workspaceId);
    } catch (error) {
      console.warn('Could not acknowledge Codex default', error);
    } finally {
      const next = new Set(this._acknowledging); next.delete(workspaceId); this._acknowledging = next;
    }
  }

  private _onWsRemove(e: Event, wsId: string, name: string): void {
    e.stopPropagation();
    const next = new Set(this._pendingClose);
    next.add(wsId);
    this._pendingClose = next;
    this.dispatchEvent(
      new CustomEvent('workspace-close', {
        detail: { workspaceId: wsId, name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _startRename(e: Event, wsId: string): void {
    e.stopPropagation();
    this._renaming = wsId;
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.ws-rename-input');
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private _finishRename(e: Event, wsId: string): void {
    const name = (e.target as HTMLInputElement).value.trim();
    this._renaming = null;
    if (name) {
      this.dispatchEvent(
        new CustomEvent('workspace-rename', {
          detail: { workspaceId: wsId, name },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _onRenameKeyDown(e: KeyboardEvent, wsId: string): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const name = (e.target as HTMLInputElement).value.trim();
      this._renaming = null;
      if (name) {
        this.dispatchEvent(
          new CustomEvent('workspace-rename', {
            detail: { workspaceId: wsId, name },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._renaming = null;
    }
  }

  /**
   * The remote Codex TUI owns server requests for turns entered in its pane,
   * so app-server observer clients receive waitingOnUserInput but not the
   * request body. Capture the small amount of presentation state the TUI
   * already renders in sessiond's authoritative VT buffer as a fallback.
   * App-server data always wins when it is available.
   */
  private _codexTerminalHint(workspaceId: string, needsQuestion: boolean): CodexTerminalHint {
    const cached = this._codexTerminalHints.get(workspaceId) ?? {};
    if (workspaceId !== store.attached) return cached;

    const driverPane = store.panes.find((pane) => pane.surfaceKind === 'driver');
    const terminal = driverPane ? terminalRegistry.getTerminal(driverPane.paneId) : null;
    if (!terminal) return cached;

    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row)?.translateToString(true).trim();
      if (line) lines.push(line);
    }

    const contextMatches = [...lines.join('\n').matchAll(/Context\s+(\d+)%\s+used/gi)];
    const lastContext = contextMatches.length > 0
      ? contextMatches[contextMatches.length - 1]?.[1]
      : undefined;
    if (lastContext !== undefined) {
      cached.contextUsed = Math.max(0, Math.min(100, Number(lastContext)));
    }

    if (needsQuestion) {
      let questionHeader = -1;
      for (let index = lines.length - 1; index >= 0; index--) {
        if (/^Question\s+\d+\/\d+/i.test(lines[index])) {
          questionHeader = index;
          break;
        }
      }
      const question = questionHeader >= 0 ? lines[questionHeader + 1] : undefined;
      if (question) cached.question = question;
    } else {
      delete cached.question;
    }

    this._codexTerminalHints.set(workspaceId, cached);
    return cached;
  }

  // ---------------------------------------------------------------------------
  // Workspace render
  // ---------------------------------------------------------------------------

  private _renderWorkspaces() {
    const activeWsId = store.attached ?? '';
    const panes = store.panes;

    return html`
      ${store.workspaces.map((ws) => {
        const isActive = ws.workspaceId === activeWsId;
        const isPendingClose = this._pendingClose.has(ws.workspaceId);
        const label = workspaceLabel(ws);
        const codexSession = store.codex.sessions.find((session) => session.workspaceId === ws.workspaceId);

        if (codexSession) {
          const needsQuestion = (codexSession.questions?.length ?? 0) > 0
            || !!codexSession.activeFlags?.includes('waitingOnUserInput');
          const needsApproval = !!codexSession.approval
            || !!codexSession.activeFlags?.includes('waitingOnApproval');
          const attention = needsQuestion || needsApproval;
          const working = codexSession.status === 'active' && !attention;
          const statusText = needsQuestion
            ? 'Needs input'
            : needsApproval
              ? 'Approval'
              : working
                ? 'Working'
                : codexSession.status === 'idle'
                  ? 'Ready'
                  : 'Paused';
          const terminalHint = this._codexTerminalHint(ws.workspaceId, needsQuestion);
          const question = codexSession.questions?.[0];
          const waitingReason = question?.question
            || terminalHint.question
            || codexSession.approval
            || (needsQuestion ? 'Codex is waiting for your answer' : undefined)
            || (needsApproval ? 'Codex is waiting for approval' : undefined)
            || 'Codex is waiting for you';
          const task = codexSession.name || codexSession.preview;
          const distinctTask = task?.trim().toLocaleLowerCase() === label.trim().toLocaleLowerCase()
            ? undefined
            : task;
          const headlineLabel = attention ? 'Decision' : codexSession.currentStep ? 'Current step' : 'Task';
          const headline = attention
            ? waitingReason
            : codexSession.currentStep || distinctTask || codexSession.cwd || 'Codex session';
          const defaultChoice = question?.options?.[0];
          const detail = attention
            ? defaultChoice ? `Default: ${defaultChoice}` : 'Accept selected default'
            : codexSession.currentStep && distinctTask ? `Task: ${distinctTask}` : codexSession.cwd;
          const contextUsed = codexSession.contextUsedPercent ?? terminalHint.contextUsed;

          return html`
            <div
              class="ws-card codex ${isActive ? 'active' : ''} ${isPendingClose ? 'pending-close' : ''}"
              @click="${() => this._onWsClick(ws.workspaceId)}"
            >
              <div class="codex-kicker">
                ${icon(Bot, { size: 12 })}
                <span class="codex-kicker-name">Codex · ${label}</span>
                <span class="codex-status ${attention ? 'attention' : working ? 'working' : ''}">${statusText}</span>
                <button
                  class="ws-remove-btn"
                  title="Remove workspace"
                  @click="${(e: Event) => this._onWsRemove(e, ws.workspaceId, label)}"
                >×</button>
              </div>
              <div class="codex-task-label">${headlineLabel}</div>
              <div class="codex-title" title="${headline}">${headline}</div>
              ${attention ? html`
                <div class="codex-attention-row">
                  <div class="codex-detail attention">${detail}</div>
                  <button class="codex-ack-btn" title="Accept the selected default and continue"
                    aria-label="Accept Codex default and continue"
                    ?disabled="${this._acknowledging.has(ws.workspaceId)}"
                    @click="${(e: Event) => void this._onCodexAcknowledge(e, ws.workspaceId)}"
                  >${icon(Check, { size: 16 })}</button>
                </div>
              ` : detail ? html`<div class="codex-detail">${detail}</div>` : ''}
              ${contextUsed !== undefined ? html`
                <div class="codex-context">
                  <div class="codex-context-track">
                    <div class="codex-context-fill" style="width:${Math.max(0, Math.min(100, contextUsed))}%"></div>
                  </div>
                  <span>${codexSession.contextRemainingPercent ?? 100 - contextUsed}% left</span>
                </div>
              ` : ''}
            </div>
          `;
        }

        // Hint row: the attached workspace shows its active pane; inactive
        // workspaces still expose useful density instead of becoming bare names.
        let hintText = ws.paneCount === 1 ? '1 pane' : `${ws.paneCount} panes`;
        if (isActive && panes.length > 0) {
          const activePane =
            panes.find((p) => p.paneId === store.activePaneId) ?? panes[0];
          const title = activePane.title?.trim() || `Pane ${activePane.paneId}`;
          const extra = panes.length - 1;
          hintText = extra > 0 ? `${title}  +${extra}` : title;
        }

        return html`
          <div
            class="ws-card ${isActive ? 'active' : ''} ${isPendingClose ? 'pending-close' : ''}"
            @click="${() => this._onWsClick(ws.workspaceId)}"
          >
            <div class="ws-header">
              <span class="dot ${isActive ? 'active' : 'inactive'}">●</span>
              ${this._renaming === ws.workspaceId
                ? html`<input
                    class="ws-rename-input"
                    type="text"
                    .value="${label}"
                    @keydown="${(e: KeyboardEvent) =>
                      this._onRenameKeyDown(e, ws.workspaceId)}"
                    @blur="${(e: Event) => this._finishRename(e, ws.workspaceId)}"
                    @click="${(e: Event) => e.stopPropagation()}"
                  />`
                : html`<span
                    class="ws-name"
                    @dblclick="${(e: Event) => this._startRename(e, ws.workspaceId)}"
                    >${label}</span
                  >`}
              <button
                class="ws-remove-btn"
                title="Remove workspace"
                @click="${(e: Event) => this._onWsRemove(e, ws.workspaceId, label)}"
              >×</button>
            </div>
            ${hintText
              ? html`<div class="ws-hint">${hintText}</div>`
              : ''}
          </div>
        `;
      })}
    `;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  override render() {
    void this._version; // suppress unused-variable lint; triggers re-render on store change
    return html`
      <div class="header">
        <span title="${window.location.hostname}">${instanceLabel()}</span>
        <div class="header-actions">
          <button
            class="launcher-btn"
            title="New workspace"
            aria-label="New workspace"
            @click="${() => this._onNewWs()}"
          >${icon(Plus, { size: 15 })}</button>
          <button
            class="launcher-btn"
            ?disabled="${store.codex.state !== 'ready'}"
            title="${store.codex.state === 'ready'
              ? 'New Codex session'
              : store.codex.error || 'Codex integration is starting'}"
            aria-label="New Codex session"
            @click="${() => this._onNewCodex()}"
          >${icon(Bot, { size: 15 })}</button>
          <button
            class="launcher-btn"
            title="Open menu"
            aria-label="Open menu"
            @click="${() => { this._menuOpen = !this._menuOpen; }}"
          >${icon(Ellipsis, { size: 15 })}</button>
        </div>
        ${this._menuOpen
          ? html`<div class="menu-anchor">
              <mux-launcher-menu
                @launcher-action="${(e: Event) => this._onLauncherAction(e)}"
              ></mux-launcher-menu>
            </div>`
          : ''}
      </div>
      <div class="tab-content">
        ${this._renderWorkspaces()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-sidebar': MuxSidebar;
  }
}
