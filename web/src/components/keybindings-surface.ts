import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { CommandId, CommandState } from '../lib/command-registry.js';
import { chordFromEvent, type BrowserKeybindings } from '../lib/browser-keybindings.js';

@customElement('mux-keybindings-surface')
export class MuxKeybindingsSurface extends LitElement {
  @property({ attribute: false }) commands: readonly CommandState[] = [];
  @property({ attribute: false }) preferences!: BrowserKeybindings;

  @state() private _recording: CommandId | null = null;
  @state() private _error = '';

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
      color: var(--chrome-text-bright);
    }

    .panel {
      padding: 24px 24px 32px;
    }

    h2 {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 20px;
      font-size: 17px;
      font-weight: 600;
    }

    .close-btn,
    .edit-shortcut,
    .reset-shortcut,
    .reset-all {
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--chrome-text-dim);
      cursor: pointer;
      font: inherit;
    }

    .close-btn {
      padding: 0 4px;
      font-size: 18px;
      line-height: 1;
    }

    .close-btn:hover,
    .edit-shortcut:hover,
    .reset-shortcut:hover,
    .reset-all:hover {
      background: var(--chrome-hover);
      color: var(--chrome-text-bright);
    }

    .command-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      align-items: center;
      gap: 12px;
      min-height: 44px;
      border-bottom: 1px solid var(--chrome-border);
    }

    .command-title {
      color: var(--chrome-text-dim);
      font-size: 13px;
    }

    .shortcut-value {
      color: var(--chrome-text-bright);
      font-family: 'JetBrainsMonoNerdFont', 'SF Mono', monospace;
      font-size: 12px;
      text-align: right;
    }

    .edit-shortcut {
      padding: 6px 8px;
      font-size: 12px;
    }

    .edit-shortcut.recording {
      outline: 2px solid var(--chrome-accent);
      color: var(--chrome-text-bright);
    }

    .reset-shortcut,
    .reset-all {
      padding: 6px 8px;
      font-size: 12px;
    }

    .reset-all {
      margin-top: 18px;
      border: 1px solid var(--chrome-border);
    }

    .reset-all:disabled {
      cursor: default;
      opacity: 0.45;
    }

    .error {
      grid-column: 1 / -1;
      margin: -2px 0 8px;
      color: var(--mux-red, #ff6b6b);
      font-size: 12px;
    }
  `;

  private _close(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _startRecording(commandId: CommandId): void {
    this._recording = commandId;
    this._error = '';
    this.toggleAttribute('data-keybinding-recorder', true);
  }

  private _record(event: KeyboardEvent, commandId: CommandId): void {
    if (this._recording !== commandId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this._finishRecording();
      return;
    }
    const chord = chordFromEvent(event);
    if (!chord) {
      this._error = 'Use a shortcut with Ctrl, Alt, or Cmd.';
      return;
    }
    const result = this.preferences.assign(commandId, chord);
    if (!result.ok) {
      this._error = result.message;
      return;
    }
    this._finishRecording();
    this._changed();
  }

  private _finishRecording(): void {
    this._recording = null;
    this._error = '';
    this.toggleAttribute('data-keybinding-recorder', false);
  }

  private _reset(commandId: CommandId): void {
    this.preferences.reset(commandId);
    this._finishRecording();
    this._changed();
  }

  private _resetAll(): void {
    this.preferences.resetAll();
    this._finishRecording();
    this._changed();
  }

  private _changed(): void {
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent('keybindings-change', { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="panel">
        <h2>
          Keyboard Shortcuts
          <button class="close-btn" aria-label="Close Keyboard Shortcuts" @click="${this._close}">×</button>
        </h2>
        ${this.commands.filter((command) => command.configurable).map((command) => html`
          <div class="command-row" data-command-id="${command.id}">
            <span class="command-title">${command.title}</span>
            <span class="shortcut-value">
              ${this.preferences.bindingsFor(command).map((shortcut) => shortcut.label).join(' / ')}
            </span>
            <button
              class="edit-shortcut ${this._recording === command.id ? 'recording' : ''}"
              aria-label="Change shortcut for ${command.title}"
              @click="${() => this._startRecording(command.id)}"
              @keydown="${(event: KeyboardEvent) => this._record(event, command.id)}"
            >${this._recording === command.id ? 'Press shortcut…' : 'Change'}</button>
            ${this.preferences.hasOverride(command.id) ? html`
              <button
                class="reset-shortcut"
                aria-label="Restore default shortcut for ${command.title}"
                @click="${() => this._reset(command.id)}"
              >Reset</button>
            ` : ''}
            ${this._recording === command.id && this._error ? html`
              <div class="error" role="alert">${this._error}</div>
            ` : ''}
          </div>
        `)}
        <button
          class="reset-all"
          ?disabled="${!this.preferences.hasOverrides()}"
          @click="${this._resetAll}"
        >Restore all defaults</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-keybindings-surface': MuxKeybindingsSurface;
  }
}
