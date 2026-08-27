import { LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { IDockviewPanel, IContentRenderer, SerializedDockview, DockviewGroupPanel } from 'dockview-core';
import { DockviewComponent } from 'dockview-core';
import dockviewCss from 'dockview-core/dist/styles/dockview.css?inline';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import { terminalRegistry } from '../lib/terminal-registry.js';
import { muxLog } from '../lib/mux-log.js';
import type { SessiondPaneInfo, LayoutCommand } from '../types.js';
import { store } from '../state.js';
import {
  FileViewerRenderer,
  basename,
  isMarkdownPath,
  type FileViewerRequest,
} from '../lib/file-viewer-renderer.js';
import {
  CREATE_TAB_COMMAND,
  DIRECTIONAL_SPLIT_COMMANDS,
  type CommandId,
  type CommandInvocation,
  type DirectionalSplit,
} from '../lib/command-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// TerminalRenderer
// Bridges the dockview panel lifecycle to terminalRegistry.
// ─────────────────────────────────────────────────────────────────────────────

class TerminalRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _paneId: number;
  private readonly _isActivePane: (paneId: number) => boolean;
  private _attached = false;

  constructor(id: string, isActivePane: (paneId: number) => boolean) {
    this._paneId = parseInt(id, 10);
    this._isActivePane = isActivePane;
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%;overflow:hidden;';

    // Isolate xterm's pointer events from dockview's panel drag-and-drop.
    //
    // dockview's ContentContainer wraps every panel in `.dv-content-container`
    // and attaches a pointer-backend drop target to it. That drop target calls
    // event.preventDefault() on pointerdown to drive panel DnD. Because this
    // element lives INSIDE `.dv-content-container`, a pointerdown that begins a
    // text-selection drag bubbles up and gets preventDefault()'d — which kills
    // xterm.js's own mouse-based selection (xterm sets `user-select: none` on
    // itself and implements selection via its SelectionService, not native
    // selection). The old `<mux-pane>` was immune because its terminal lived in
    // a shadow root; light DOM removed that boundary.
    //
    // stopPropagation() keeps these events from reaching dockview's drop target
    // while leaving xterm's listeners (on descendants) fully functional. Panel
    // focus uses focus/blur events, not pointer events, so it is unaffected.
    const swallow = (e: Event): void => e.stopPropagation();
    el.addEventListener('pointerdown', swallow);
    el.addEventListener('pointermove', swallow);
    el.addEventListener('pointerup', swallow);

    this.element = el;
  }

  init(): void {
    // Do NOT attach here. Dockview calls init() before the panel has final
    // layout dimensions. Attaching here (even via rAF) causes the terminal
    // to open at wrong cols/rows, making the PTY replay garbled ($$$$~~~~~).
    // Attachment is deferred to the first layout() call (element connected +
    // has real dimensions) via terminalRegistry.setContainer().
    muxLog('renderer init', `pane=${this._paneId}`, {
      hasTerminal: terminalRegistry.getTerminal(this._paneId) !== null,
    });
  }

  layout(): void {
    if (!this._attached) {
      muxLog('renderer layout', `pane=${this._paneId} not-yet-attached`,
        { isConnected: this.element.isConnected,
          w: this.element.offsetWidth, h: this.element.offsetHeight,
          isActive: this._isActivePane(this._paneId) });

      if (!this.element.isConnected) {
        // Panel not in DOM yet — retry next frame (dockview only calls layout()
        // on the active panel after DOM append; inactive panels get one
        // isConnected=false call and nothing after).
        requestAnimationFrame(() => this.layout());
        return;
      }

      // Element is connected. Hand off to the registry's independent lifecycle:
      // setContainer() either calls attach() immediately (if ensure() already
      // ran) or stores the container for attach() to be called when ensure()
      // runs later. Either way the terminal opens without depending on a
      // specific render-cycle ordering.
      this._attached = true;
      terminalRegistry.setContainer(this._paneId, this.element, this._isActivePane(this._paneId));
      return;
    }
    terminalRegistry.fitIfVisible(this._paneId);
  }

  focus(): void {
    terminalRegistry.focus(this._paneId);
  }

  dispose(): void {
    // Does NOT destroy the terminal — PTY stays alive, scrollback preserved.
    terminalRegistry.detach(this._paneId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PlaceholderRenderer
// Renders a non-interactive placeholder for client-rendered `browser` panes.
// The web client cannot host a cross-origin webview, so browser panes created by
// the native apps appear here as an opaque, render-only slot. It never errors and
// never disturbs the surrounding dockview layout.
// ─────────────────────────────────────────────────────────────────────────────

class PlaceholderRenderer implements IContentRenderer {
  readonly element: HTMLElement;

  constructor(_id: string) {
    const el = document.createElement('div');
    el.style.cssText =
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'text-align:center;padding:24px;box-sizing:border-box;' +
      'color:var(--chrome-text-dim);background:var(--chrome-body);user-select:none;font-size:13px;';
    el.innerHTML =
      '<div><div style="font-size:15px;color:var(--mux-fg);font-weight:600;margin-bottom:8px;">' +
      'Browser pane</div><div>Browser panes are available in the native apps.</div></div>';
    this.element = el;
  }

  init(): void {}
  layout(): void {}
  focus(): void {}
  dispose(): void {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a placement token (from MCP create_pane or layout-command) to the
 * corresponding dockview AddPanelOptions direction.
 * Anything unrecognised falls back to 'right'.
 */
function placementToDirection(placement: string | undefined): 'left' | 'right' | 'above' | 'below' {
  switch (placement) {
    case 'split-left':  return 'left';
    case 'split-above': return 'above';
    case 'split-below': return 'below';
    default:            return 'right'; // split-right or unknown
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HeaderButton
// A single icon button used as a dockview header action. Two are mounted per
// group, in different dockview header slots:
//   [+]    — left action slot (renders right after the tabs): new pane as a TAB
//   [split] — right action slot (far right): split into a side-by-side group
// ─────────────────────────────────────────────────────────────────────────────

const ADD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

// VS Code-style split icon: two side-by-side rectangles.
const SPLIT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
  <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
  <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/>
</svg>`;

class HeaderButton {
  readonly element: HTMLElement;

  constructor(icon: string, title: string, onClick: () => void) {
    const btn = document.createElement('button');
    btn.className = 'mux-header-btn';
    btn.title = title;
    btn.innerHTML = icon;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    this.element = btn;
  }

  init(): void { /* nothing to initialise */ }
  dispose(): void { this.element.remove(); }
}

/** Desktop Split trigger with one explicit menu item per directional Command. */
class SplitHeaderMenu {
  readonly element: HTMLElement;
  private readonly _menu: HTMLElement;

  private readonly _onOutsidePointerDown = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this.element)) this._menu.hidden = true;
  };

  constructor(onCommand: (commandId: CommandId) => void) {
    const root = document.createElement('div');
    root.className = 'mux-split-control';

    const trigger = document.createElement('button');
    trigger.className = 'mux-header-btn';
    trigger.title = 'Split pane';
    trigger.setAttribute('aria-label', 'Split pane');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.innerHTML = SPLIT_ICON;

    const menu = document.createElement('div');
    menu.className = 'mux-split-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const command of DIRECTIONAL_SPLIT_COMMANDS) {
      const item = document.createElement('button');
      item.className = 'mux-split-menu-item';
      item.dataset.commandId = command.id;
      item.setAttribute('role', 'menuitem');
      item.textContent = command.title;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.hidden = true;
        onCommand(command.id);
      });
      menu.appendChild(item);
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    root.append(trigger, menu);
    this.element = root;
    this._menu = menu;
    document.addEventListener('pointerdown', this._onOutsidePointerDown, { capture: true });
  }

  init(): void { /* nothing to initialise */ }

  dispose(): void {
    document.removeEventListener('pointerdown', this._onOutsidePointerDown, { capture: true });
    this.element.remove();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MuxDock
// ─────────────────────────────────────────────────────────────────────────────

/** Unique ID for the injected mux-dock style tag; prevents double-inject. */
const STYLE_ID = 'mux-dock-styles';

@customElement('mux-dock')
export class MuxDock extends LitElement {
  // Light DOM is REQUIRED for dockview DnD to work.
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) panes: SessiondPaneInfo[] = [];
  @property({ attribute: false }) activePaneId = -1;
  @property({ attribute: false }) workspaceKey = '';
  @property({ attribute: false }) layout = '';

  /** Temporarily maximize the active group while a touch software keyboard is
   * visible. This is presentation-only and must never enter the saved layout. */
  @property({ attribute: false, type: Boolean }) keyboardFocusMode = false;

  /** Test hook: exposes the MuxStore instance for E2E verification scripts. */
  readonly __store = store;
  /**
   * Narrow (phone) mode: a tab view only. No split button, no saved/restored
   * layout — all panes collapse into a single dockview group as tabs. Wide
   * (tablet + PC) gets the full split layout with save/restore.
   */
  @property({ attribute: false, type: Boolean }) narrow = false;

  private _dv: DockviewComponent | null = null;
  private _panels = new Map<number, IDockviewPanel>();
  /** Client-local, read-only file panels. These are deliberately absent from
   * sessiond's pane composition and are discarded on workspace switch. */
  private _filePanels = new Map<string, { key: string; panel?: IDockviewPanel }>();
  private _nextFilePanelId = 1;
  private _settingActive = false;
  /** User-defined pane names — persists across workspace switches for the session. */
  private _customTitles = new Map<number, string>();
  /**
   * Pane IDs closed by the user via the dockview tab X button.
   * These are excluded from reconciler re-adds (Case 2) until the
   * workspace changes (Case 1 clears this set).
   */
  private _locallyClosedPanes = new Set<number>();
  /** Pointer type that initiated the most recent interaction ('mouse' | 'touch' | 'pen').
   *  Read in onDidRemovePanel to decide whether a close should be deferred.
   *  NOTE: best-effort — if two tabs are closed within a single animation frame,
   *  the second pointerdown overwrites this before the first onDidRemovePanel fires.
   *  Currently harmless (all close types share the same grace duration). Revisit
   *  with a per-tab WeakMap if per-input-type durations are ever added.
   */
  private _lastPointerType: string = 'mouse';
  /** Bound capture-phase handler so we can remove it in disconnectedCallback. */
  private _onPointerDownCapture = (e: PointerEvent): void => {
    this._lastPointerType = e.pointerType || 'mouse';

    // Dockview prevents pointerdown on its tab close and overflow controls so
    // they do not start a drag. WebKit treats that cancelled pointerdown as a
    // reason to suppress the synthetic click that follows a touch tap, leaving
    // the controls inert on iPad/iPhone. Stop the touch pointerdown before it
    // reaches dockview instead; the later click remains uncancelled and the
    // existing click handlers run normally. Header buttons are included so a
    // tap on our new-tab/split controls cannot be claimed by dockview's header
    // drag surface. Tab bodies deliberately fall through so touch reordering
    // keeps using dockview's pointer drag backend.
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(
        '.dv-default-tab-action, .dv-tabs-overflow-dropdown-root, .mux-header-btn',
      )) {
        e.stopPropagation();
      }
    }
  };
  /**
   * Bound document pointerup handler — deactivates browser-pane drag shields
   * after a dockview drag gesture ends. Registered in capture phase so it fires
   * even if the pointer is released over an iframe.
   */
  private _onDragPointerUp = (): void => {
    this._setDragShields(false);
  };
  /** True while we're programmatically removing panels to suppress pane-close events. */
  private _removingPanels = false;
  /** Debounce timer for layout-save events. */
  private _layoutSaveTimer: number | undefined;
  /** True while restoring a layout via fromJSON — suppresses layout-save echoes. */
  private _restoringLayout = false;
  /** Pane maximized by keyboard focus mode. Null means any current maximize
   * state predates focus mode and must be preserved when the keyboard closes. */
  private _keyboardFocusMaximizedPaneId: number | null = null;
  /**
   * Where the NEXT newly-added pane should be placed:
   *   'tab'   — a new tab in the active group (the "+" button)
   *   'split' — a new group placed in the requested direction beside the
   *             Active Pane
   * The reconciler reads this when the real (server-assigned) pane arrives,
   * then resets it to the 'tab' default.
   */
  private _nextPlacement: 'tab' | 'split' = 'tab';
  /** Dockview direction to use when _nextPlacement === 'split'. Defaults to 'right'. */
  private _splitDirection: 'left' | 'right' | 'above' | 'below' = 'right';
  /** ID of the panel to split from when _nextPlacement === 'split'. */
  private _splitReferenceId: string | null = null;
  /**
   * ID of the panel used for tab or Split placement. Clicking "+" on an
   * inactive group adds the tab there; directional Commands set this to the
   * globally Active Pane.
   */
  private _placementReferenceId: string | null = null;

  /**
   * Record the desired tab group and invoke the backing create-tab Command.
   */
  private _requestTab(group?: DockviewGroupPanel): void {
    this._nextPlacement = 'tab';
    // Prefer the clicked group's active panel as the reference; fall back to
    // the globally active panel only if the group is unknown.
    this._placementReferenceId =
      group?.activePanel?.id ?? this._dv?.activePanel?.id ?? null;
    this._splitReferenceId = null;
    this._invokeCommand(CREATE_TAB_COMMAND.id);
  }

  private _invokeCommand(commandId: CommandId): void {
    this.dispatchEvent(new CustomEvent<CommandInvocation>('command-invoke', {
      bubbles: true,
      composed: true,
      detail: { commandId },
    }));
  }

  /**
   * Extract the saved GLOBAL active pane id from the persisted layout JSON.
   * dockview's fromJSON restores each group's per-group activeView but does NOT
   * reliably re-activate the top-level activeGroup, so we read it ourselves:
   * find the grid leaf whose group id === activeGroup, and return that leaf's
   * activeView (the pane id). Returns undefined if the layout can't tell us.
   */
  private _activePaneIdFromSavedLayout(): string | undefined {
    try {
      const parsed = JSON.parse(this.layout) as SerializedDockview & { activeGroup?: string };
      const activeGroup = parsed.activeGroup;
      if (activeGroup === undefined) return undefined;
      // Walk the grid tree to find the leaf node whose data.id === activeGroup.
      let found: string | undefined;
      const visit = (node: { type?: string; data?: unknown }): void => {
        if (found !== undefined || !node) return;
        if (node.type === 'leaf') {
          const d = node.data as { id?: string; activeView?: string } | undefined;
          if (d?.id === activeGroup) found = d.activeView;
          return;
        }
        const children = (node.data as { type?: string }[] | undefined) ?? [];
        for (const child of children) visit(child as { type?: string; data?: unknown });
      };
      visit(parsed.grid?.root as { type?: string; data?: unknown });
      return found;
    } catch {
      return undefined;
    }
  }

  /**
   * Show or hide drag shields on all browser panes in this dock.
   * Called with `true` when dockview reports a drag start, `false` on pointerup.
   */
  private _setDragShields(active: boolean): void {
    for (const el of this.querySelectorAll<HTMLElement>('.mux-drag-shield')) {
      el.style.display = active ? 'block' : 'none';
    }
  }

  private _scheduleLayoutSave(): void {
    if (this.narrow) return; // narrow (phone) is a tab view — no persisted layout
    if (this.keyboardFocusMode) return; // transient keyboard maximize is not durable layout
    if (this._restoringLayout) return; // don't echo a save while we're restoring
    // Viewer panels are client-local and cannot be reconstructed by sessiond.
    // Pause persistence while one is open so its component id/params never
    // contaminate the durable terminal layout; closing the last viewer saves.
    if (this._filePanels.size > 0) return;
    if (this._layoutSaveTimer !== undefined) clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = window.setTimeout(() => {
      if (!this._dv) return;
      const json = JSON.stringify(this._dv.toJSON());
      this.dispatchEvent(new CustomEvent('layout-save', { detail: { layout: json }, bubbles: true, composed: true }));
    }, 400);
  }

  /** Keep Dockview's maximized group aligned with the active terminal while
   * keyboard focus mode is open, and restore the prior split when it closes. */
  private _syncKeyboardFocusMode(): void {
    if (!this._dv) return;

    if (!this.keyboardFocusMode) {
      const paneId = this._keyboardFocusMaximizedPaneId;
      this._keyboardFocusMaximizedPaneId = null;
      const panel = paneId === null ? undefined : this._panels.get(paneId);
      if (panel?.api.isMaximized()) panel.api.exitMaximized();
      return;
    }

    // A pending pre-keyboard save could otherwise fire after maximize() and
    // accidentally persist this transient presentation state.
    if (this._layoutSaveTimer !== undefined) {
      clearTimeout(this._layoutSaveTimer);
      this._layoutSaveTimer = undefined;
    }

    const activePanel = this._panels.get(this.activePaneId);
    if (!activePanel) return;

    if (this._keyboardFocusMaximizedPaneId !== null
      && this._keyboardFocusMaximizedPaneId !== this.activePaneId) {
      const previous = this._panels.get(this._keyboardFocusMaximizedPaneId);
      if (previous?.api.isMaximized()) previous.api.exitMaximized();
      this._keyboardFocusMaximizedPaneId = null;
    }

    // Preserve a maximize that existed before the keyboard opened. We only
    // restore states that this mode created itself.
    if (!activePanel.api.isMaximized()) {
      activePanel.api.maximize();
      this._keyboardFocusMaximizedPaneId = this.activePaneId;
    }
  }

  private _refreshBellTitles(): void {
    for (const [paneId, panel] of this._panels) {
      const rawTitle =
        this._customTitles.get(paneId) ??
        this.panes.find((p) => p.paneId === paneId)?.title ??
        `Pane ${paneId}`;
      const tabEl = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
        .view?.tab?.element?.querySelector<HTMLElement>('.dv-default-tab-content');
      if (!tabEl) continue;
      tabEl.textContent = '';
      if (store.paneBellActive(paneId)) {
        const bell = document.createElement('span');
        bell.className = 'mux-bell-prefix';
        bell.textContent = '● ';
        tabEl.appendChild(bell);
      }
      tabEl.appendChild(document.createTextNode(rawTitle));
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();

    // mux-dock is a light-DOM element but lives inside mux-app's ShadowRoot.
    // All styles must be injected into that ShadowRoot — document.head styles
    // cannot pierce a shadow boundary.
    const root = this.getRootNode();
    const target = root instanceof ShadowRoot ? root : document.head;

    // Inject xterm.js's stylesheet into the SAME root as dockview's CSS, here at
    // connect time. This is deterministic: mux-dock reliably lives inside
    // mux-app's ShadowRoot, so this.getRootNode() resolves to that ShadowRoot
    // and the stylesheet is present BEFORE any terminal attaches.
    //
    // Doing it here (rather than lazily per-terminal at attach time via the
    // container's getRootNode) avoids a race: during dockview's fromJSON layout
    // restore, a panel's element can attach while still in a detached subtree,
    // so its getRootNode() returns a document fragment and xterm.css lands in
    // document.head — which cannot pierce the shadow boundary, leaving xterm's
    // measurement elements unstyled and leaking as $$$$~~~~. Injecting once,
    // early, into the shadow root sidesteps the timing entirely.
    const XTERM_BASE_ID = 'xterm-base-css';
    if (!target.querySelector(`#${XTERM_BASE_ID}`)) {
      const xt = document.createElement('style');
      xt.id = XTERM_BASE_ID;
      xt.textContent = xtermCss;
      target.appendChild(xt);
    }

    // Inject dockview's full CSS (base layout + all themes) into the shadow root.
    // Must live here so dockview's theme class selectors can reach panel elements.
    const BASE_ID = 'dockview-base-css';
    if (!target.querySelector(`#${BASE_ID}`)) {
      const base = document.createElement('style');
      base.id = BASE_ID;
      base.textContent = dockviewCss;
      target.appendChild(base);
    }

    // Base = dockview's built-in "abyss" theme (for its flat STRUCTURE only:
    // zero tab radius/margin, transparent sashes). We re-skin all of its colours
    // with the active palette's semantic chrome tokens so the tab bar matches
    // agent-remote's title bar:
    //   • active tabs merge into the terminal body,
    //   • the tab bar and inactive tabs share the title-bar surface with dimmer
    //     text, so unselected tabs recede,
    //   • the active tab carries a blue top accent border as the selection cue.
    if (!target.querySelector(`#${STYLE_ID}`)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        mux-dock {
          display: block;
          flex: 1;
          width: 100%;
          height: 100%;
        }

        /* FitAddon deliberately rounds the terminal grid down to whole rows.
           Keep xterm's interactive/background root stretched to the panel edge
           so the fractional remainder does not become a dead strip at the
           bottom after mobile safe-area and header height changes. The screen
           and canvases retain their exact cell-grid dimensions. */
        mux-dock .xterm {
          height: 100%;
        }
        mux-dock .xterm .xterm-viewport {
          background-color: var(--mux-bg);
        }

        /* xterm's DOM renderer keeps glyphs (including true-colour output) in
           this layer, separate from its opaque viewport background. A palette
           may soften that content to evoke native terminal translucency
           without allowing anything behind the terminal to show through. */
        mux-dock .xterm .xterm-rows {
          opacity: var(--mux-terminal-text-opacity, 1);
        }

        /* Dockview re-skin: every surface follows the fixed Agent Remote tokens. */
        mux-dock .dv-dockview {
          --dv-background-color: var(--chrome-body);
          --dv-tabs-and-actions-container-height: 34px;
          --dv-tabs-and-actions-container-font-size: 13px;
          --dv-icon-hover-background-color: var(--chrome-hover);

          /* Panel CONTENT background. Must equal the terminal background so the
             few sub-character pixels left when xterm can't fill the pane to an
             exact row height don't bleed a contrasting color. */
          --dv-group-view-background-color: var(--mux-bg);

          /* Tab bar surface — same as the title bar so the chrome reads as one
             continuous band. */
          --dv-tabs-and-actions-container-background-color: var(--chrome-bar);

          /* Active group: selected tab merges into the body, others into the bar. */
          --dv-activegroup-visiblepanel-tab-background-color: var(--chrome-body);
          --dv-activegroup-hiddenpanel-tab-background-color: var(--chrome-bar);
          /* Inactive group (unfocused split): same hierarchy, no extra dimming. */
          --dv-inactivegroup-visiblepanel-tab-background-color: var(--chrome-body);
          --dv-inactivegroup-hiddenpanel-tab-background-color: var(--chrome-bar);

          /* Text: selected bright, unselected dim. */
          --dv-activegroup-visiblepanel-tab-color: var(--chrome-text-bright);
          --dv-activegroup-hiddenpanel-tab-color: var(--chrome-text-dim);
          --dv-inactivegroup-visiblepanel-tab-color: var(--mux-fg);
          --dv-inactivegroup-hiddenpanel-tab-color: var(--chrome-text-dim);

          /* Quiet but visible hairlines give each pane and tab a crisp edge. */
          --dv-separator-border: var(--chrome-border);
          --dv-tab-divider-color: var(--chrome-border);

          /* Resize sash: invisible track, accent only while dragging. */
          --dv-sash-color: transparent;
          --dv-active-sash-color: var(--chrome-accent);
        }

        /* Chrome-like tab sizing.
           Dockview DOM order: [scrollable+tabs] [left-actions (+)] [void] [right-actions (split)]
           Size the scrollable from the combined tab widths so sibling tabs do not stack in
           the first tab's footprint. It may still shrink when the pane is too narrow, at
           which point Dockview's horizontal overflow handling takes over. The void keeps its
           default flex-grow so the split control remains pinned to the far right. */

        mux-dock .dv-scrollable {
          flex: 0 1 max-content;
          min-width: 0;
        }

        /* cmux tabs hug their content instead of reserving a large fixed slot.
           The min/max bounds retain usable close targets and predictable
           truncation for long shell titles. */
        mux-dock .dv-tab {
          border-top: 2px solid transparent;
          flex: 0 0 auto !important;
          width: max-content;
          padding: 0 8px !important; /* beats dv-single-tab's zero padding */
          min-width: var(--mux-tab-min-width, 76px);
          max-width: var(--mux-tab-max-width, 168px);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        mux-dock .dv-tab.dv-active-tab {
          border-top: 2px solid var(--chrome-accent) !important;
        }

        mux-dock .dv-tab .dv-default-tab-content {
          display: flex;
          align-items: center;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Small terminal mark mirrors cmux's pane identity cue without adding
           another label or consuming meaningful horizontal space. */
        mux-dock .dv-tab .dv-default-tab-content::before {
          content: '';
          width: 12px;
          height: 12px;
          margin-right: 6px;
          flex: 0 0 12px;
          background: currentColor;
          -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1.5' y='2.5' width='13' height='11' rx='1.5' fill='none' stroke='black' stroke-width='1.5'/%3E%3Cpath d='m4 6 2 2-2 2m4-0.25h3' fill='none' stroke='black' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1.5' y='2.5' width='13' height='11' rx='1.5' fill='none' stroke='black' stroke-width='1.5'/%3E%3Cpath d='m4 6 2 2-2 2m4-0.25h3' fill='none' stroke='black' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
          opacity: 0.9;
        }
        mux-dock .mux-file-tab .dv-default-tab-content::before {
          -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 1.75h6l4 4v8.5H3z' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'/%3E%3Cpath d='M9 1.75v4h4' fill='none' stroke='black' stroke-width='1.4'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 1.75h6l4 4v8.5H3z' fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'/%3E%3Cpath d='M9 1.75v4h4' fill='none' stroke='black' stroke-width='1.4'/%3E%3C/svg%3E") center / contain no-repeat;
        }

        /* Close button — show on hover + always on active tab */
        mux-dock .dv-tab .dv-default-tab-action {
          opacity: 0;
          margin-left: 2px;
          padding: 3px !important;
          border-radius: 3px;
          transition: opacity 0.15s;
        }
        mux-dock .dv-tab .dv-default-tab-action svg {
          fill: var(--mux-fg);
        }
        mux-dock .dv-tab:hover .dv-default-tab-action,
        mux-dock .dv-tab.dv-active-tab .dv-default-tab-action {
          opacity: 1;
        }

        /* Header action icon buttons ("+" after the tabs, split far right) */
        mux-dock .mux-header-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          align-self: center;
          width: 26px;
          height: 26px;
          margin: 0 3px;
          padding: 0;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--mux-fg);
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.12s, color 0.12s;
        }
        mux-dock .mux-header-btn:hover {
          background: color-mix(in srgb, var(--chrome-accent) 15%, transparent);
          color: var(--chrome-text-bright);
        }
        mux-dock .mux-header-btn:active {
          background: color-mix(in srgb, var(--chrome-accent) 25%, transparent);
        }

        mux-dock .mux-split-control {
          position: relative;
          display: flex;
          align-items: center;
          height: 100%;
        }

        mux-dock .mux-split-menu {
          position: absolute;
          top: calc(100% - 1px);
          right: 0;
          z-index: 1500;
          min-width: 130px;
          padding: 4px;
          border: 1px solid var(--chrome-border);
          border-radius: 5px;
          background: var(--chrome-bar);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }

        mux-dock .mux-split-menu[hidden] {
          display: none;
        }

        mux-dock .mux-split-menu-item {
          display: block;
          width: 100%;
          padding: 6px 10px;
          border: 0;
          border-radius: 3px;
          background: transparent;
          color: var(--chrome-text-bright);
          font: inherit;
          font-size: 12px;
          text-align: left;
          cursor: pointer;
        }

        mux-dock .mux-split-menu-item:hover,
        mux-dock .mux-split-menu-item:focus-visible {
          background: var(--chrome-hover);
          outline: none;
        }

        /* dockview's action containers shrink-wrap their button and sit at the
           header's top edge, so the 28px button is top-pinned in the 35px bar.
           Make the containers full-height and center their content so the
           "+" / split buttons line up with the vertical middle of the tabs. */
        mux-dock .dv-left-actions-container,
        mux-dock .dv-right-actions-container {
          display: flex;
          align-items: center;
          height: 100%;
        }

        /* Inline tab rename input */
        mux-dock .mux-tab-rename-input {
          background: var(--chrome-bar);
          color: var(--chrome-text-bright);
          border: 1px solid var(--chrome-accent);
          border-radius: 3px;
          padding: 0 4px;
          font: inherit;
          font-size: inherit;
          outline: none;
          width: 100px;
          min-width: 60px;
          max-width: 160px;
        }

        /* Bell dot prefix on pane tabs */
        mux-dock .mux-bell-prefix {
          color: var(--mux-bell, #e0af68);
          font-style: normal;
        }

        mux-dock .mux-file-viewer {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: var(--mux-fg);
          background: var(--chrome-body);
        }
        mux-dock .mux-file-viewer-toolbar {
          height: 32px;
          flex: 0 0 32px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 10px;
          border-bottom: 1px solid var(--chrome-border);
          background: var(--chrome-bar);
          color: var(--chrome-text-dim);
          font-size: 11px;
        }
        mux-dock .mux-file-viewer-path {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--mux-terminal-font-family, monospace);
        }
        mux-dock .mux-file-viewer-mode {
          color: var(--chrome-accent);
        }
        mux-dock .mux-file-viewer-reload,
        mux-dock .mux-file-viewer-status button {
          border: 1px solid var(--chrome-border);
          border-radius: 4px;
          padding: 3px 8px;
          background: var(--chrome-hover);
          color: var(--chrome-text-bright);
          font: inherit;
          cursor: pointer;
        }
        mux-dock .mux-file-viewer-scroll {
          flex: 1;
          min-height: 0;
          overflow: auto;
          outline: none;
        }
        mux-dock .mux-file-viewer-body {
          min-height: 100%;
          box-sizing: border-box;
        }
        mux-dock .mux-file-viewer-status {
          margin: auto;
          max-width: min(560px, calc(100% - 48px));
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          color: var(--chrome-text-dim);
        }
        mux-dock .mux-file-viewer-status.error strong { color: var(--mux-error); }
        mux-dock .mux-file-viewer-status code {
          max-width: 100%;
          overflow-wrap: anywhere;
          color: var(--mux-fg);
        }
        mux-dock .mux-text-body { padding: 12px 0 40px; }
        mux-dock .mux-file-lines {
          margin: 0;
          padding: 0 0 0 60px;
          color: var(--chrome-text-dim);
          font: 12px/1.55 var(--mux-terminal-font-family, monospace);
        }
        mux-dock .mux-file-line {
          min-height: 1.55em;
          padding: 0 20px 0 12px;
          white-space: pre;
        }
        mux-dock .mux-file-line::marker { color: color-mix(in srgb, var(--chrome-text-dim) 65%, transparent); }
        mux-dock .mux-file-line code { color: var(--mux-fg); font: inherit; }
        mux-dock .mux-file-line-selected {
          background: color-mix(in srgb, var(--chrome-accent) 16%, transparent);
          box-shadow: inset 2px 0 var(--chrome-accent);
        }
        mux-dock .mux-markdown-body {
          width: min(860px, 100%);
          margin: 0 auto;
          padding: 34px 42px 70px;
          font: 15px/1.65 system-ui, -apple-system, sans-serif;
          color: var(--mux-fg);
        }
        mux-dock .mux-markdown-body h1,
        mux-dock .mux-markdown-body h2,
        mux-dock .mux-markdown-body h3,
        mux-dock .mux-markdown-body h4 {
          margin: 1.6em 0 0.55em;
          line-height: 1.25;
          color: var(--chrome-text-bright);
        }
        mux-dock .mux-markdown-body h1 { margin-top: 0; font-size: 2em; }
        mux-dock .mux-markdown-body h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--chrome-border); }
        mux-dock .mux-markdown-body p,
        mux-dock .mux-markdown-body ul,
        mux-dock .mux-markdown-body ol,
        mux-dock .mux-markdown-body blockquote,
        mux-dock .mux-markdown-body pre,
        mux-dock .mux-markdown-body table { margin: 0 0 1em; }
        mux-dock .mux-markdown-body ul,
        mux-dock .mux-markdown-body ol { padding-left: 1.7em; }
        mux-dock .mux-markdown-body a { color: var(--chrome-accent); }
        mux-dock .mux-markdown-body blockquote {
          padding-left: 1em;
          border-left: 3px solid var(--chrome-accent);
          color: var(--chrome-text-dim);
        }
        mux-dock .mux-markdown-body code {
          border-radius: 3px;
          padding: 0.15em 0.35em;
          background: var(--chrome-bar);
          color: var(--chrome-text-bright);
          font: 0.9em var(--mux-terminal-font-family, monospace);
        }
        mux-dock .mux-markdown-body pre {
          overflow: auto;
          padding: 14px 16px;
          border: 1px solid var(--chrome-border);
          border-radius: 6px;
          background: var(--chrome-bar);
        }
        mux-dock .mux-markdown-body pre code { padding: 0; background: transparent; }
        mux-dock .mux-markdown-body table { border-collapse: collapse; }
        mux-dock .mux-markdown-body th,
        mux-dock .mux-markdown-body td { padding: 6px 10px; border: 1px solid var(--chrome-border); }
        mux-dock .mux-markdown-body img { max-width: 100%; }

        /* Mobile: hide tab bar on narrow viewports */
        @media (max-width: 768px) {
          mux-dock .dv-tabs-and-actions-container {
            display: none !important;
          }
        }

      `;
      target.appendChild(style);
    }

    // Record the pointer type that starts each interaction. The capture phase
    // guarantees we see it before dockview processes the click and fires
    // onDidRemovePanel, so the close branch knows whether it was a touch/pen.
    this.addEventListener('pointerdown', this._onPointerDownCapture, { capture: true });
    // Capture-phase pointerup on the document deactivates browser-pane drag
    // shields after any dockview drag gesture ends (including releases over iframes).
    document.addEventListener('pointerup', this._onDragPointerUp, { capture: true });
    this.classList.add('dockview-theme-abyss');
    this.addEventListener('dblclick', this._onTabDblClick);
    this._dv = new DockviewComponent(this, {
      createComponent: (opts) => {
        if (opts.name === 'browser') return new PlaceholderRenderer(opts.id);
        if (opts.name === 'markdown') return new FileViewerRenderer('markdown');
        if (opts.name === 'text') return new FileViewerRenderer('text');
        return new TerminalRenderer(opts.id, (paneId) => paneId === this.activePaneId);
      },
      // dockview header DOM order is: [tabs] [left-actions] [void] [right-actions].
      // The "left" slot therefore renders immediately after the tabs (before
      // the grow-to-fill void), and the "right" slot renders far right.
      //   "+"    → left slot  → sits just right of the tabs (new pane as a TAB)
      //   split  → right slot → far right (opens the directional Command menu)
      // The factory receives the dockview group its header belongs to, so the
      // "+" on an INACTIVE group still targets THAT group. Split Commands use
      // the globally Active Pane as their reference.
      createLeftHeaderActionComponent: (group) =>
        new HeaderButton(ADD_ICON, CREATE_TAB_COMMAND.title, () => this._requestTab(group)),
      // Narrow (phone) is a tab view only — no split button.
      createRightHeaderActionComponent: () => {
        if (this.narrow) {
          return new HeaderButton('', '', () => {});
        }
        return new SplitHeaderMenu((commandId) => this._invokeCommand(commandId));
      },
    });
    this._dv.onDidLayoutChange(() => this._scheduleLayoutSave());
    // Activate drag shields on all browser panes when a dockview drag starts so
    // the iframe doesn't swallow pointermove/pointerup during the gesture.
    this._dv.onWillDragPanel(() => this._setDragShields(true));
    this._dv.onWillDragGroup(() => this._setDragShields(true));
    this._dv.onDidActivePanelChange((panel) => {
      if (this._settingActive) return;
      if (!panel) return;
      if (this._filePanels.has(panel.id)) {
        window.dispatchEvent(new CustomEvent('non-browser-pane-activated'));
        return;
      }
      const paneId = parseInt(panel.id, 10);
      store.ackPane(paneId); // clear bell indicator when tab is focused directly
      this.dispatchEvent(new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }));
      // Defer focus to next frame: calling term.focus() synchronously inside the
      // dockview tab-click handler fires BEFORE the browser finishes resolving
      // focus for the clicked tab element, so the browser steals it back. An rAF
      // defers until after the click event is fully processed.
      requestAnimationFrame(() => terminalRegistry.focus(paneId));
      // For browser-cdp panes: dispatch a window event so mux-browser-pane
      // can send browser-focus and resume the Chromium screencast.
      // Deferred with rAF for the same reason terminal focus is deferred above:
      // dispatching synchronously fires canvas.focus() while dockview still
      // holds its own focus lock, so the browser steals it back immediately.
      const paneInfo = this.panes.find((p) => p.paneId === paneId);
      if (paneInfo?.surfaceKind === 'browser') {
        // Placeholder pane: nothing to focus, no screencast to resume.
      } else {
        // Signal to browser panes that they are no longer the active panel.
        // Browser panes use this to stop capturing window-level keyboard events.
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('non-browser-pane-activated'));
        });
      }
      // Persist the new active selection: onDidLayoutChange does NOT fire on a
      // pure active-tab switch, so without this the saved layout keeps a stale
      // activeView and the wrong pane is selected after a refresh.
      this._scheduleLayoutSave();
    });
    this._dv.onDidRemovePanel((panel) => {
      if (this._removingPanels) return;
      if (this._filePanels.delete(panel.id)) {
        this._scheduleLayoutSave();
        return;
      }
      const paneId = parseInt(panel.id, 10);
      if (this._panels.has(paneId)) {
        // Capture the tab title BEFORE deleting the panel record — the toast
        // labels itself "<title> closed". Falls back to "Pane N".
        const title = panel.title ?? `Pane ${paneId}`;
        // touch is retained in the event detail for observability and future use
        // (e.g. per-input-type grace period durations), even though _onClosePane
        // no longer branches on it.
        const touch = this._lastPointerType === 'touch' || this._lastPointerType === 'pen';
        this._panels.delete(paneId);
        this._locallyClosedPanes.add(paneId);
        this.dispatchEvent(
          new CustomEvent('pane-close', {
            detail: { paneId, touch, title },
            bubbles: true,
            composed: true,
          }),
        );
      }
      requestAnimationFrame(() => {
        if (this._dv) {
          this._dv.layout(this.offsetWidth, this.offsetHeight, true);
        }
      });
    });

    // Middle-click on a dockview tab closes that pane.
    // Uses the same onDidRemovePanel → pane-close flow as the tab X button,
    // giving the user the same 10-second undo toast on accidental middle-clicks.
    this.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 1) return; // only middle click
      e.preventDefault(); // prevent the browser autoscroll cursor

      // Walk the event path (composed — works across shadow boundaries) to find
      // the dockview tab element. The class is confirmed by the CSS above.
      const path = e.composedPath() as Element[];
      const tabEl = path.find(
        (el) => el instanceof Element && el.classList?.contains('dv-tab'),
      ) as Element | undefined;
      if (!tabEl) return;

      // Match the found .dv-tab element to a panel.
      // panel.view.tab.element is the inner .dv-default-tab child, NOT the .dv-tab
      // container itself, so compare by containment: tabEl.contains(panelTabEl).
      for (const panel of this._dv?.panels ?? []) {
        const panelTabEl = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
          .view?.tab?.element;
        if (panelTabEl && tabEl.contains(panelTabEl)) {
          if (this._dv) this._dv.removePanel(panel);
          return;
        }
      }
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('pointerdown', this._onPointerDownCapture, { capture: true });
    document.removeEventListener('pointerup', this._onDragPointerUp, { capture: true });
    this._dv?.dispose();
    this._dv = null;
  }

  /** Handle double-click on a dockview default tab — starts inline rename. */
  private _onTabDblClick = (e: MouseEvent): void => {
    const tabContent = (e.target as Element).closest?.('.dv-default-tab-content') as HTMLElement | null;
    if (!tabContent) return;

    // Use the active panel for the pane ID. By the time dblclick fires, the
    // single-click has already activated this tab, so activePanel is correct.
    const activePanel = this._dv?.activePanel;
    if (!activePanel) return;
    if (this._filePanels.has(activePanel.id)) return;

    const paneId = parseInt(activePanel.id, 10);
    const currentTitle = (tabContent.textContent ?? '').replace(/^● /, '');

    // Hide the tab text and insert an input in its place.
    tabContent.style.display = 'none';
    const input = document.createElement('input');
    input.className = 'mux-tab-rename-input';
    input.value = currentTitle;
    tabContent.parentElement?.insertBefore(input, tabContent.nextSibling);
    input.focus();
    input.select();

    const finish = (save: boolean): void => {
      const next = save ? (input.value.trim() || currentTitle) : currentTitle;
      input.remove();
      tabContent.style.display = '';
      tabContent.textContent = '';
      if (store.paneBellActive(paneId)) {
        const bell = document.createElement('span');
        bell.className = 'mux-bell-prefix';
        bell.textContent = '● ';
        tabContent.appendChild(bell);
      }
      tabContent.appendChild(document.createTextNode(next));
      if (save && next !== currentTitle) {
        this._customTitles.set(paneId, next);
        this.dispatchEvent(new CustomEvent('pane-rename', { detail: { paneId, name: next }, bubbles: true, composed: true }));
      }
    };

    input.addEventListener('blur', () => finish(true), { once: true });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // prevent dockview / xterm from seeing keystrokes
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') {
        // Remove the blur listener before removing the input
        input.replaceWith(input); // detach + reattach tricks the once listener off
        finish(false);
      }
    });
  };

  override updated(changed: Map<string, unknown>): void {
    if (!this._dv) return;

    // Case 1: workspaceKey changed → full panel reset
    if (changed.has('workspaceKey')) {
      muxLog('dock case1', `workspaceKey changed`,
        { workspaceKey: this.workspaceKey, panes: this.panes.map(p => p.paneId),
          activePaneId: this.activePaneId, hasLayout: !!this.layout });
      this._settingActive = true;
      this._removingPanels = true;
      try {
        // Any tracked maximize belongs to the outgoing Dockview groups.
        this._keyboardFocusMaximizedPaneId = null;
        // Clear locally-closed set: new workspace starts fresh.
        this._locallyClosedPanes.clear();
        // Close all existing panels
        for (const panel of this._dv.panels) {
          this._dv.removePanel(panel);
        }
        this._panels.clear();
        this._filePanels.clear();

        // Seed _customTitles from server-stored titles (arrive in composition panes).
        for (const pane of this.panes) {
          if (pane.title) this._customTitles.set(pane.paneId, pane.title);
        }

        // Try to restore the saved dockview layout (wide mode only). Narrow
        // (phone) is a tab view only: skip restore so all panes collapse into a
        // single dockview group as tabs.
        const alive = new Set(this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId));
        let restored = false;
        if (!this.narrow && this.layout) {
          try {
            this._restoringLayout = true;
            muxLog('dock restore', 'calling fromJSON', { layoutLength: this.layout.length });
            this._dv.fromJSON(JSON.parse(this.layout) as SerializedDockview);
            // Rebuild the panel map from whatever fromJSON recreated.
            this._panels.clear();
            for (const panel of this._dv.panels) {
              this._panels.set(parseInt(panel.id, 10), panel);
            }
            // Prune panels whose pane died while we were away.
            // (_removingPanels is already true from outer guard — no inner reset needed.)
            // Snapshot entries before iterating since we mutate _panels in the loop.
            for (const [paneId, panel] of Array.from(this._panels)) {
              if (!alive.has(paneId)) {
                this._dv.removePanel(panel);
                this._panels.delete(paneId);
              }
            }
            // Add any alive panes that weren't in the saved layout (created elsewhere).
            for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
              if (!this._panels.has(pane.paneId)) {
                const panel = this._dv.addPanel({
                  id: String(pane.paneId),
                  component: pane.surfaceKind ?? 'terminal',
                  title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
                });
                this._panels.set(pane.paneId, panel);
              }
            }
            restored = this._panels.size > 0;
            muxLog('dock restore', 'fromJSON complete', { panelCount: this._panels.size, restored });
          } catch (e) {
            // Corrupt/incompatible layout — fall back to a clean tab build.
            muxLog('dock restore', 'fromJSON FAILED — falling back', { err: String(e) });
            restored = false;
            this._panels.clear();
            this._dv.clear();
          } finally {
            this._restoringLayout = false;
          }
        }

        if (!restored) {
          // Existing behavior: add fresh panels for panes with valid paneId as tabs.
          for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
            const panel = this._dv.addPanel({
              id: String(pane.paneId),
              component: pane.surfaceKind ?? 'terminal',
              title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
            });
            this._panels.set(pane.paneId, panel);
          }
        }

        if (restored) {
          // dockview's fromJSON restores each group's per-group activeView, but
          // does NOT reliably re-activate the saved top-level activeGroup — it
          // reverts the GLOBAL active panel to the first group. So explicitly
          // re-activate the panel named by the saved layout's activeGroup +
          // that group's activeView. Fall back to dockview's own activePanel
          // only if the saved layout can't tell us.
          const _fromLayout = this._activePaneIdFromSavedLayout();
          const _fromDv = this._dv.activePanel?.id;
          muxLog('dock restore', 'active pane resolution',
            { fromLayout: _fromLayout, fromDockview: _fromDv, storeActivePaneId: this.activePaneId });
          const activePaneId = _fromLayout ?? _fromDv;
          if (activePaneId !== undefined) {
            const paneId = parseInt(String(activePaneId), 10);
            const panel = this._panels.get(paneId);
            muxLog('dock restore', `setActive pane=${paneId}`, { panelFound: !!panel });
            if (panel) {
              // setActive makes this panel's group the GLOBAL active group.
              panel.api.setActive();
            }
            // Do NOT force store's activePaneId (hard-coded to panes[0]) — sync
            // the store to the restored selection instead.
            this.dispatchEvent(
              new CustomEvent('pane-select', { detail: { paneId }, bubbles: true, composed: true }),
            );
            // Re-assert as the LAST word. The synchronous setActive(above) holds
            // through the microtask but is clobbered on the next animation frame:
            // terminals attach via a deferred rAF and each calls term.focus(),
            // and dockview activates a group on focus (onDidFocus). The attach
            // focus-storm lands on the stale store-default pane, reverting the
            // active group. Re-activating AND focusing the restored pane after
            // those frames makes it stick (and leaves it keyboard-focused).
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (this._panels.get(paneId)?.api.setActive) {
                  this._panels.get(paneId)?.api.setActive();
                  terminalRegistry.focus(paneId);
                }
              });
            });
          }
        } else {
          // Fresh tab build — honor the store's active pane.
          const activePanel = this._panels.get(this.activePaneId);
          if (activePanel) {
            activePanel.api.setActive();
          }
        }
      } finally {
        this._settingActive = false;
        this._removingPanels = false;
      }
      this._refreshBellTitles();
      this._syncKeyboardFocusMode();
      return;
    }

    // Case 2: panes changed → diff (add/remove panels)
    if (changed.has('panes')) {
      const currentPaneIds = new Set(this.panes.filter((p) => p.paneId >= 0).map((p) => p.paneId));

      // Remove panels for panes that were removed server-side.
      // Guard with _removingPanels so onDidRemovePanel doesn't re-fire pane-close.
      this._removingPanels = true;
      try {
        for (const [paneId, panel] of this._panels) {
          if (!currentPaneIds.has(paneId)) {
            this._dv.removePanel(panel);
            this._panels.delete(paneId);
          }
        }
      } finally {
        this._removingPanels = false;
      }

      // Add panels for new panes, skipping panes the user closed locally.
      for (const pane of this.panes.filter((p) => p.paneId >= 0)) {
        if (!this._panels.has(pane.paneId) && !this._locallyClosedPanes.has(pane.paneId)) {
          const opts: Parameters<NonNullable<typeof this._dv>['addPanel']>[0] = {
            id: String(pane.paneId),
            component: pane.surfaceKind ?? 'terminal',
            title: this._customTitles.get(pane.paneId) ?? pane.title ?? `Pane ${pane.paneId}`,
          };
          // Honor a pending placement request, positioned relative to the group
          // whose header button was clicked (so "+" / split on an INACTIVE
          // group targets THAT group, not the active one).
          if (this._nextPlacement === 'split' && this._splitReferenceId !== null) {
            // New split group next to the reference panel in the requested direction.
            opts.position = { referencePanel: this._splitReferenceId, direction: this._splitDirection };
          } else if (this._nextPlacement === 'tab' && this._placementReferenceId !== null) {
            // New tab WITHIN the clicked group (also activates that group).
            opts.position = { referencePanel: this._placementReferenceId, direction: 'within' };
          }
          // Reset placement intent now that it's been consumed.
          this._nextPlacement = 'tab';
          this._splitDirection = 'right';
          this._splitReferenceId = null;
          this._placementReferenceId = null;
          const panel = this._dv.addPanel(opts);
          this._panels.set(pane.paneId, panel);
          panel.api.setActive();
        }
      }
    }

    // Case 3: activePaneId changed → set active panel
    if (changed.has('activePaneId')) {
      muxLog('dock case3', `activePaneId changed to ${this.activePaneId}`,
        { panels: [...this._panels.keys()], prevActivePaneId: changed.get('activePaneId') });
      const panel = this._panels.get(this.activePaneId);
      if (panel && !panel.api.isActive) {
        this._settingActive = true;
        try {
          panel.api.setActive();
        } finally {
          this._settingActive = false;
        }
        // onDidActivePanelChange is suppressed while _settingActive=true, so
        // focus would never be placed in the terminal for programmatic pane
        // switches (store-driven: pane-picker, initial load, workspace restore).
        // rAF: same reason as onDidActivePanelChange — defer until after the
        // browser finishes resolving focus for the panel/tab element.
        const paneIdToFocus = this.activePaneId;
        requestAnimationFrame(() => terminalRegistry.focus(paneIdToFocus));
      }
    }
    this._syncKeyboardFocusMode();
    // Bell dot updates are reactive without a direct store.subscribe() here:
    // mux-app.render() passes store.panes.filter() which always returns a new
    // array reference on every store notification. Lit tracks the new reference
    // as a changed property and triggers this updated() call, which then calls
    // _refreshBellTitles(). If the render path ever caches the filtered array,
    // this reactivity chain would silently break — hence this comment.
    this._refreshBellTitles();
  }

  /**
   * Read xterm.js buffer for playwright verification.
   * Returns the full scrollback buffer content as a newline-joined string.
   */
  getTerminalContent(paneId: number): string {
    const term = terminalRegistry.getTerminal(paneId);
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  /** Read the active xterm.js buffer kind for playwright verification. */
  getTerminalBufferType(paneId: number): 'normal' | 'alternate' | '' {
    return terminalRegistry.getTerminal(paneId)?.buffer.active.type ?? '';
  }

  /** Read live xterm appearance options for real-browser verification. */
  getTerminalAppearance(paneId: number): {
    background: string;
    selectionForeground: string;
    allowTransparency: boolean;
    textOpacity: string;
  } | null {
    const term = terminalRegistry.getTerminal(paneId);
    if (!term) return null;
    const rows = term.element?.querySelector('.xterm-rows');
    return {
      background: term.options.theme?.background ?? '',
      selectionForeground: term.options.theme?.selectionForeground ?? '',
      allowTransparency: term.options.allowTransparency ?? false,
      textOpacity: rows ? getComputedStyle(rows).opacity : '',
    };
  }

  /**
   * Open a read-only file viewer as a tab beside the terminal that originated
   * the Shift-click. Repeated opens of the same resolved request reuse the
   * existing tab and update its requested line rather than multiplying tabs.
   */
  openFile(request: FileViewerRequest): void {
    if (!this._dv || !request.path) return;
    const key = `${request.cwd ?? ''}\u0000${request.path}`;
    for (const entry of this._filePanels.values()) {
      if (entry.key !== key || !entry.panel) continue;
      entry.panel.api.updateParameters(request);
      entry.panel.api.setActive();
      return;
    }

    const id = `file-${this._nextFilePanelId++}`;
    // Seed before addPanel: dockview may synchronously announce activation
    // while constructing the panel, and that callback must recognize this as
    // a local viewer rather than parse its id as a numeric sessiond pane.
    const entry: { key: string; panel?: IDockviewPanel } = { key };
    this._filePanels.set(id, entry);
    try {
      const active = this._dv.activePanel;
      const panel = this._dv.addPanel({
        id,
        component: isMarkdownPath(request.path) ? 'markdown' : 'text',
        title: basename(request.path),
        params: request,
        ...(active ? { position: { referencePanel: active, direction: 'within' as const } } : {}),
      });
      entry.panel = panel;
      const tabElement = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
        .view?.tab?.element;
      tabElement?.closest('.dv-tab')?.classList.add('mux-file-tab');
      panel.api.setActive();
    } catch (error) {
      this._filePanels.delete(id);
      throw error;
    }
  }

  /**
   * Cycle to the next (or previous) tab within the active panel's dockview
   * group. Deliberately does NOT cross split-pane group boundaries — only tabs
   * in the same visual group as the currently focused panel are considered.
   * No-op when there is no active panel or the group contains only one tab.
   */
  cycleTabInGroup(direction: 'next' | 'prev' = 'next'): void {
    if (!this._dv) return;
    const active = this._dv.activePanel;
    if (!active) return;

    // Collect all tracked panels that share the same dockview group, preserving
    // _panels Map insertion order (= tab creation order, used as proxy for the
    // visual tab sequence within the group).
    const sameGroup: IDockviewPanel[] = [];
    for (const panel of this._dv.panels) {
      if (panel.group === active.group) sameGroup.push(panel);
    }

    if (sameGroup.length <= 1) return;

    const cur = sameGroup.findIndex((p) => p.id === active.id);
    if (cur === -1) return;

    const next =
      direction === 'next'
        ? (cur + 1) % sameGroup.length
        : (cur - 1 + sameGroup.length) % sameGroup.length;

    sameGroup[next]?.api.setActive();
  }

  /**
   * Close the currently active dockview panel programmatically, triggering the
   * same pane-close event flow as the tab X-button (deferred close + undo toast).
   * No-op if there is no active panel.
   */
  closeActivePanel(): void {
    if (!this._dv) return;
    const active = this._dv.activePanel;
    if (!active) return;
    this._dv.removePanel(active);
  }

  /** Arm the next PaneAdded for a Split relative to the current Active Pane. */
  prepareDirectionalSplit(direction: DirectionalSplit, referencePaneId: number): boolean {
    if (!this._dv || !this._panels.has(referencePaneId)) return false;
    this._nextPlacement = 'split';
    this._splitDirection = direction === 'up' ? 'above' : direction === 'down' ? 'below' : direction;
    this._splitReferenceId = String(referencePaneId);
    this._placementReferenceId = String(referencePaneId);
    return true;
  }

  /**
   * Undo a local close: re-enable the reconciler for this pane and re-add its
   * dockview panel immediately. The server never heard about the close during
   * the grace period, so store.panes still has the entry, the PTY is alive, and
   * terminalRegistry still holds the xterm instance — the panel comes back with
   * full scrollback. Position is NOT preserved (re-adds at the default slot).
   */
  reopenPane(paneId: number): void {
    this._locallyClosedPanes.delete(paneId);
    if (!this._dv) return;
    if (this._panels.has(paneId)) return; // already on screen, nothing to do
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) return; // pane no longer exists (e.g. process exited during grace)
    const panel = this._dv.addPanel({
      id: String(paneId),
      component: pane.surfaceKind ?? 'terminal',
      title: this._customTitles.get(paneId) ?? pane.title ?? `Pane ${paneId}`,
    });
    this._panels.set(paneId, panel);
    panel.api.setActive();
  }

  /**
   * Re-enable reconciliation for a set of pane IDs that were locally closed
   * but whose server-side PTY survived (e.g. grace-period cancel on disconnect).
   * The reconciler will re-add their tabs on the next render cycle.
   */
  allowReconcile(paneIds: Iterable<number>): void {
    for (const id of paneIds) {
      this._locallyClosedPanes.delete(id);
    }
  }

  /**
   * Pre-wire placement intent for an incoming pane-added event from a
   * server-initiated (e.g. MCP) create-pane that carries placement info.
   *
   * Must be called synchronously BEFORE store.applySessiond() triggers the
   * Lit reactive update that runs the reconciler. Unlike _requestPane, this
   * does NOT dispatch 'pane-create' — the pane already exists server-side.
   */
  preparePlacementForPaneAdded(placement: string, referencePaneId?: number): void {
    const refId = referencePaneId !== undefined && referencePaneId > 0
      ? String(referencePaneId)
      : (this._dv?.activePanel?.id ?? null);
    if (placement === 'tab') {
      this._nextPlacement = 'tab';
      this._placementReferenceId = refId;
      this._splitReferenceId = null;
    } else {
      // split-right | split-left | split-above | split-below
      this._nextPlacement = 'split';
      this._splitDirection = placementToDirection(placement);
      this._splitReferenceId = refId;
      this._placementReferenceId = refId;
    }
  }

  /**
   * Execute a layout command from the server: create-pane, rename-pane,
   * close-pane, or switch-workspace. Replaces the Phase 2 stub.
   */
  handleLayoutCommand(msg: LayoutCommand): void {
    const dv = this._dv;
    if (!dv) return;
    switch (msg.command) {
      case 'create-pane': {
        const refId = msg.referencePaneId !== undefined
          ? String(msg.referencePaneId)
          : (dv.activePanel?.id ?? null);
        if (msg.placement === 'tab') {
          this._nextPlacement = 'tab';
          this._placementReferenceId = refId;
          this._splitReferenceId = null;
        } else {
          this._nextPlacement = 'split';
          this._splitDirection = placementToDirection(msg.placement);
          this._splitReferenceId = refId;
          this._placementReferenceId = refId;
        }
        this.dispatchEvent(
          new CustomEvent('pane-create', {
            bubbles: true,
            composed: true,
            detail: { kind: msg.kind, url: msg.url },
          }),
        );
        break;
      }
      case 'rename-pane': {
        if (msg.paneId === undefined) return;
        this._customTitles.set(msg.paneId, msg.name ?? '');
        const panel = this._panels.get(msg.paneId);
        if (panel) {
          const tabContent = (panel as unknown as { view?: { tab?: { element?: HTMLElement } } })
            .view?.tab?.element?.querySelector('.dv-default-tab-content');
          if (tabContent) tabContent.textContent = msg.name ?? '';
        }
        this.dispatchEvent(
          new CustomEvent('pane-rename', {
            bubbles: true,
            composed: true,
            detail: { paneId: msg.paneId, name: msg.name ?? '' },
          }),
        );
        break;
      }
      case 'close-pane': {
        if (msg.paneId === undefined) return;
        const panel = this._panels.get(msg.paneId);
        if (panel && this._dv) {
          this._dv.removePanel(panel);
        }
        break;
      }
      case 'switch-workspace': {
        if (!msg.workspaceId) return;
        this.dispatchEvent(
          new CustomEvent('workspace-switch', {
            bubbles: true,
            composed: true,
            detail: { workspaceId: msg.workspaceId },
          }),
        );
        break;
      }
    }
  }

}

declare global {
  interface HTMLElementTagNameMap {
    'mux-dock': MuxDock;
  }
}
