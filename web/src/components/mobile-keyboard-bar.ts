import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import { terminalRegistry } from '../lib/terminal-registry.js';
import {
  mobileTerminalInput,
  type MobileInputTarget,
  type MobileModifier,
  type MobileTerminalKey,
} from '../lib/mobile-terminal-input.js';

interface KeyDefinition {
  key: MobileTerminalKey;
  label: string;
  title: string;
}

const KEYS: readonly KeyDefinition[] = [
  { key: 'escape', label: 'Esc', title: 'Escape' },
  { key: 'tab', label: 'Tab', title: 'Tab' },
  { key: 'arrow-left', label: '←', title: 'Left arrow' },
  { key: 'arrow-up', label: '↑', title: 'Up arrow' },
  { key: 'arrow-down', label: '↓', title: 'Down arrow' },
  { key: 'arrow-right', label: '→', title: 'Right arrow' },
  { key: 'pipe', label: '|', title: 'Pipe' },
  { key: 'slash', label: '/', title: 'Slash' },
  { key: 'tilde', label: '~', title: 'Tilde' },
];

/** Mobile-only terminal key strip. Modifier buttons are one-shot: arm one,
 * then either type on the software keyboard or tap another key in the strip. */
@customElement('mux-mobile-keyboard-bar')
export class MuxMobileKeyboardBar extends LitElement {
  @property({ type: String }) workspaceId = '';
  @property({ type: Number }) paneId = -1;
  @property({ type: Boolean }) showCommandKey = false;

  static styles = css`
    :host {
      display: flex;
      flex: none;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      border-top: 1px solid var(--chrome-border);
      background: var(--chrome-bar);
      padding: 5px max(6px, env(safe-area-inset-right)) max(5px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left));
      user-select: none;
      -webkit-user-select: none;
    }

    .keys {
      display: flex;
      flex: 1;
      min-width: 0;
      gap: 5px;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }

    .keys::-webkit-scrollbar {
      display: none;
    }

    button {
      flex: 0 0 auto;
      min-width: 44px;
      height: 36px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--chrome-border);
      border-radius: 6px;
      background: var(--chrome-body);
      color: var(--chrome-text-bright);
      /* UI keys must paint immediately even while xterm's bundled Nerd Font
         is still loading on a fresh PWA launch. */
      font: 12px/1 ui-monospace, 'SF Mono', Menlo, monospace;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }

    button.symbol {
      font-size: 16px;
    }

    button.modifier[aria-pressed='true'] {
      border-color: var(--chrome-accent);
      background: var(--chrome-accent);
      color: var(--chrome-body);
      font-weight: 700;
    }

    button:active {
      background: var(--chrome-hover);
    }

    button.modifier[aria-pressed='true']:active {
      background: var(--chrome-accent);
    }
  `;

  private _unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._unsubscribe = mobileTerminalInput.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    mobileTerminalInput.clear(this._target());
    this._unsubscribe?.();
    this._unsubscribe = null;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (!changed.has('workspaceId') && !changed.has('paneId')) return;

    const previousWorkspaceId = changed.has('workspaceId')
      ? changed.get('workspaceId')
      : this.workspaceId;
    const previousPaneId = changed.has('paneId')
      ? changed.get('paneId')
      : this.paneId;
    if (typeof previousWorkspaceId === 'string' && typeof previousPaneId === 'number') {
      mobileTerminalInput.clear({ workspaceId: previousWorkspaceId, paneId: previousPaneId });
    }
  }

  private _target(): MobileInputTarget {
    return { workspaceId: this.workspaceId, paneId: this.paneId };
  }

  private _pressModifier(event: PointerEvent, modifier: MobileModifier): void {
    if (event.button !== 0) return;
    event.preventDefault();
    mobileTerminalInput.toggle(this._target(), modifier);
    terminalRegistry.focus(this.paneId);
  }

  private _pressKey(event: PointerEvent, key: MobileTerminalKey): void {
    if (event.button !== 0) return;
    event.preventDefault();
    terminalRegistry.sendMobileKey(this.paneId, key);
  }

  override render() {
    const activeModifier = mobileTerminalInput.modifierFor(this._target());

    return html`
      <div class="keys" role="toolbar" aria-label="Terminal keys">
        <button
          class="modifier"
          title="Control (applies to the next key)"
          aria-label="Control modifier"
          aria-pressed="${activeModifier === 'ctrl'}"
          @pointerdown="${(event: PointerEvent) => this._pressModifier(event, 'ctrl')}"
        >Ctrl</button>
        <button
          class="modifier"
          title="Alt (applies to the next key)"
          aria-label="Alt modifier"
          aria-pressed="${activeModifier === 'alt'}"
          @pointerdown="${(event: PointerEvent) => this._pressModifier(event, 'alt')}"
        >Alt</button>
        ${this.showCommandKey ? html`
          <button
            class="modifier"
            title="Command (applies to the next app shortcut)"
            aria-label="Command modifier"
            aria-pressed="${activeModifier === 'meta'}"
            @pointerdown="${(event: PointerEvent) => this._pressModifier(event, 'meta')}"
          >Cmd</button>
        ` : ''}
        ${KEYS.map(({ key, label, title }) => html`
          <button
            class="${label.length === 1 ? 'symbol' : ''}"
            title="${title}"
            aria-label="${title}"
            @pointerdown="${(event: PointerEvent) => this._pressKey(event, key)}"
          >${label}</button>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-mobile-keyboard-bar': MuxMobileKeyboardBar;
  }
}
