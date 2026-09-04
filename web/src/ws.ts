import {
  SessiondType,
  encodePaneFrame,
  decodePaneFrame,
  type CloseConfirmRequest,
  type CloseIntentRequest,
  type CloseOutcome,
  type CloseRisk,
  type CloseRiskReason,
  type CloseTarget,
  type PaneContext,
  type SessiondMessage,
} from './types';
import type { MuxStore } from './state';

export type PaneOutputCallback = (paneId: number, data: Uint8Array) => void;
export type ControlMessageCallback = (msg: Record<string, unknown>) => void;

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30000;
const JITTER_MAX = 500;
const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;
const INVALID_CLOSE_TICKET_FAILURE = 'invalid-close-ticket';
const CLOSE_RISK_REASONS = new Set<CloseRiskReason>([
  'command-active', 'foreground-process', 'custom-command', 'browser-pane', 'driver-pane',
  'unsupported-shell', 'unsupported-platform', 'missing-lifecycle', 'stale-lifecycle',
  'process-inspection-failed', 'pty-inspection-failed', 'conflicting-evidence',
]);

interface PendingCloseRequest {
  target: CloseTarget;
  kind: 'intent' | 'confirm';
  resolve: (outcome: CloseOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasValidCloseTarget(message: Record<string, unknown>): boolean {
  if (typeof message.workspaceId !== 'string' || message.workspaceId.length === 0) return false;
  if (message.targetKind === 'pane') return isPositiveSafeInteger(message.paneId);
  return message.targetKind === 'workspace' && message.paneId === undefined;
}

function isCloseRisk(value: unknown): value is CloseRisk {
  if (typeof value !== 'object' || value === null) return false;
  const risk = value as Record<string, unknown>;
  return isPositiveSafeInteger(risk.paneId) && typeof risk.title === 'string' &&
    (risk.classification === 'busy' || risk.classification === 'unknown') &&
    typeof risk.reason === 'string' && CLOSE_RISK_REASONS.has(risk.reason as CloseRiskReason);
}

function sameCloseTarget(left: CloseTarget, right: CloseTarget): boolean {
  return left.targetKind === right.targetKind && left.workspaceId === right.workspaceId &&
    (left.targetKind === 'workspace' || (right.targetKind === 'pane' && left.paneId === right.paneId));
}

function isCloseOutcome(value: unknown): value is CloseOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== SessiondType.CloseOutcome || !isPositiveSafeInteger(message.cid) || !hasValidCloseTarget(message)) return false;
  if (message.closeStatus === 'closed') return true;
  if (message.closeStatus === 'failed') {
    return (message.failureCode === undefined || typeof message.failureCode === 'string') &&
      (message.error === undefined || typeof message.error === 'string');
  }
  return message.closeStatus === 'confirmation-required' && typeof message.ticket === 'string' &&
    message.ticket.length > 0 && isNonNegativeSafeInteger(message.busyCount) &&
    isNonNegativeSafeInteger(message.unknownCount) && Array.isArray(message.risks) &&
    message.risks.every(isCloseRisk) && isNonNegativeSafeInteger(message.omittedRiskCount);
}

export class MuxSocket {
  private _store: MuxStore;
  private _url: string;
  private _ws: WebSocket | null = null;
  private _paneOutputCb: PaneOutputCallback | null = null;
  private _controlMessageCb: ControlMessageCallback | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _intentionalClose = false;
  private _nextRequestCid = 1;
  private _pendingPaneCWD = new Map<number, {
    resolve: (cwd: string | undefined) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private _pendingPaneContext = new Map<number, {
    resolve: (context: PaneContext | undefined) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private _pendingImagePastes = new Map<number, {
    resolve: (path: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private _pendingCloseRequests = new Map<number, PendingCloseRequest>();

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  onSessiondMessage: ((msg: SessiondMessage) => void) | null = null;
  /**
   * Fires when the daemon broadcasts pane-resized: the canonical PTY size for
   * paneId changed because some other client became (or already was)
   * authoritative for it. A direct callback property, like onDisconnect/
   * onReconnect above — not the window CustomEvent relay pattern used below
   * for browser-action/layout-command, since the only consumer
   * (terminalRegistry) is a plain module app.ts already imports directly; no
   * need for a window-event round-trip.
   */
  onPaneResized: ((paneId: number, cols: number, rows: number) => void) | null = null;

  constructor(store: MuxStore, url: string) {
    this._store = store;
    this._url = url;
  }

  onPaneOutput(cb: PaneOutputCallback): void {
    this._paneOutputCb = cb;
  }

  onControlMessage(cb: ControlMessageCallback): void {
    this._controlMessageCb = cb;
  }

  connect(): void {
    this._intentionalClose = false;
    this._reconnectAttempts = 0;
    this._open();
  }

  disconnect(): void {
  this._intentionalClose = true;
  this._rejectPendingCloseRequests(new Error('The close outcome could not be confirmed because the connection closed.'));
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._resolvePendingPaneCWD();
    this._rejectPendingImagePastes('Terminal disconnected during image upload');
  }

  sendPaneInput(paneId: number, data: Uint8Array): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(encodePaneFrame(paneId, data));
    }
  }

  // --- sessiond v1 control senders -----------------------------------------
  // All senders emit the FLAT SessiondMessage envelope (no single-key
  // wrapping) and consume the frozen SessiondType vocabulary, never raw
  // strings.

  /** Send one flat sessiond control message if the socket is open. */
  private sendSessiond(msg: SessiondMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /** Attach this connection to a workspace. */
  attach(workspaceId: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId });
  }

  /** Attach, telling the daemon our responsive breakpoint so it returns the
   *  matching saved layout in the composition reply. */
  attachWithBreakpoint(workspaceId: string, breakpoint: string): void {
    this.sendSessiond({ type: SessiondType.Attach, workspaceId, breakpoint });
  }

  renamePane(paneId: number, name: string): void {
    this.sendSessiond({ type: SessiondType.RenamePane, paneId, name });
  }

  saveLayout(workspaceId: string, breakpoint: string, layout: string): void {
    this.sendSessiond({ type: SessiondType.SaveLayout, workspaceId, breakpoint, layout });
  }

  /** Request the list of workspaces. */
  listWorkspaces(): void {
    this.sendSessiond({ type: SessiondType.ListWorkspaces });
  }

  /**
   * Create a new workspace; name and clientRef are each included only when
   * truthy.
   */
  createWorkspace(name?: string, clientRef?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreateWorkspace };
    if (name) msg.name = name;
    if (clientRef) msg.clientRef = clientRef;
    this.sendSessiond(msg);
  }

  /** Rename an existing workspace. */
  renameWorkspace(workspaceId: string, name: string): void {
    this.sendSessiond({ type: SessiondType.RenameWorkspace, workspaceId, name });
  }

  /** Assess and, when safe, close a pane or workspace in one correlated request. */
  closeIntent(target: CloseTarget): Promise<CloseOutcome> {
    return this._sendCloseRequest(target, 'intent', (cid) => {
      if (target.targetKind === 'pane') {
        return {
          type: SessiondType.CloseIntent,
          cid,
          targetKind: 'pane',
          workspaceId: target.workspaceId,
          paneId: target.paneId,
        };
      }
      return {
        type: SessiondType.CloseIntent,
        cid,
        targetKind: 'workspace',
        workspaceId: target.workspaceId,
      };
    });
  }

  /** Confirm exactly the opaque assessment ticket returned by sessiond. */
  closeConfirm(ticket: string, target: CloseTarget): Promise<CloseOutcome> {
    return this._sendCloseRequest(target, 'confirm', (cid) => ({ type: SessiondType.CloseConfirm, cid, ticket }));
  }

  /** A structural broadcast supersedes any still-pending reply for this target. */
  settleCloseTarget(target: CloseTarget): void {
    for (const [cid, pending] of this._pendingCloseRequests) {
      if (sameCloseTarget(pending.target, target)) this._resolvePendingAsClosed(cid, pending);
    }
  }

  /** Workspace removal also settles pane-close requests scoped to that workspace. */
  settleCloseWorkspace(workspaceId: string): void {
    for (const [cid, pending] of this._pendingCloseRequests) {
      if (pending.target.workspaceId === workspaceId) this._resolvePendingAsClosed(cid, pending);
    }
  }

  /**
   * Create a connection-scoped pane (NO workspaceId). Optional fields are
   * included only when populated. A relative cwd is resolved by sessiond from
   * the Session Owner's home directory.
   */
  createPane(cmd?: string[], clientRef?: string, surfaceKind?: 'terminal' | 'driver', cwd?: string): void {
    const msg: SessiondMessage = { type: SessiondType.CreatePane };
    if (cmd && cmd.length > 0) msg.cmd = cmd;
    if (clientRef) msg.clientRef = clientRef;
    if (surfaceKind === 'driver') msg.surfaceKind = surfaceKind;
    if (cwd) msg.cwd = cwd;
    this.sendSessiond(msg);
  }

  /** Open a browser CDP pane on the server side. */
  createBrowserPane(): void {
    this.sendSessiond({ type: SessiondType.CreateBrowserPane });
  }

  /**
   * Report a pane's measured rendered grid (active-view-wins by construction:
   * only visible panes own a live ResizeObserver, so tabbed-away panes never
   * call resize).
   */
  resize(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.Resize, paneId, cols, rows });
  }

  /**
   * Claim PTY-sizing authority for a pane: sent when it becomes this client's
   * visible+OS-focused view (dockview active-tab change, visibilitychange,
   * window focus, or initial attach/reconnect). Carries this client's current
   * measured size so the daemon can resize the PTY in the same round-trip
   * rather than waiting for a separate resize message afterward. Mirrors
   * resize()'s shape exactly — same three fields, different type.
   */
  paneFocus(paneId: number, cols: number, rows: number): void {
    this.sendSessiond({ type: SessiondType.PaneFocus, paneId, cols, rows });
  }

  /** Ask the Session Owner for the Pane process's live cwd. This is the
   * authoritative path for relative terminal links; OSC 7/1337 remains a
   * fallback for platforms where process cwd inspection is unavailable. */
  paneCWD(paneId: number): Promise<string | undefined> {
    if (!this.connected) return Promise.resolve(undefined);

    const cid = this._nextRequestCid++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingPaneCWD.delete(cid);
        resolve(undefined);
      }, 3000);
      this._pendingPaneCWD.set(cid, { resolve, timeout });
      this.sendSessiond({ type: SessiondType.GetPaneCWD, cid, paneId });
    });
  }

  paneContext(paneId: number): Promise<PaneContext | undefined> {
    if (!this.connected) return Promise.resolve(undefined);
    const cid = this._nextRequestCid++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { this._pendingPaneContext.delete(cid); resolve(undefined); }, 3000);
      this._pendingPaneContext.set(cid, { resolve, timeout });
      this.sendSessiond({ type: SessiondType.GetPaneContext, cid, paneId });
    });
  }

  /** Persist an explicitly pasted browser clipboard image on the Session Owner
   * host. The returned path resolves on the same host as the pane's PTY. */
  async pasteImage(paneId: number, image: Blob): Promise<string> {
    if (!this.connected) throw new Error('Terminal is disconnected');
    if (image.size === 0 || image.size > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error('Image must be between 1 byte and 5 MiB');
    }
    const data = await blobToBase64(image);
    if (!this.connected) throw new Error('Terminal disconnected during image upload');

    const cid = this._nextRequestCid++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingImagePastes.delete(cid);
        reject(new Error('Image upload timed out'));
      }, 15000);
      this._pendingImagePastes.set(cid, { resolve, reject, timeout });
      this.sendSessiond({
        type: SessiondType.PasteImage,
        cid,
        paneId,
        mimeType: image.type || 'application/octet-stream',
        data,
      });
    });
  }

  destroy(): void {
  this._intentionalClose = true;
  this._rejectPendingCloseRequests(new Error('The close outcome could not be confirmed because the connection was destroyed.'));
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    if (this._ws) {
      this._ws.close(1000);
      this._ws = null;
    }
    this._resolvePendingPaneCWD();
    this._rejectPendingImagePastes('Terminal disconnected during image upload');
  }

  get connected(): boolean {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_BASE * 2 ** this._reconnectAttempts, BACKOFF_CAP);
    const jitter = Math.random() * JITTER_MAX;
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._open(), delay + jitter);
  }

  private _sendCloseRequest(
    target: CloseTarget,
    kind: PendingCloseRequest['kind'],
    buildMessage: (cid: number) => CloseIntentRequest | CloseConfirmRequest,
  ): Promise<CloseOutcome> {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Cannot request close while disconnected.'));
    const cid = this._nextRequestCid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pendingCloseRequests.get(cid);
        if (!pending) return;
        this._pendingCloseRequests.delete(cid);
        pending.reject(new Error('The close outcome could not be confirmed before the request timed out.'));
      }, CLOSE_REQUEST_TIMEOUT_MS);
      this._pendingCloseRequests.set(cid, { target, kind, resolve, reject, timer });
      try {
        ws.send(JSON.stringify(buildMessage(cid)));
      } catch (error) {
        clearTimeout(timer);
        this._pendingCloseRequests.delete(cid);
        reject(error instanceof Error ? error : new Error('The close request could not be sent.'));
      }
    });
  }

  private _resolveCloseOutcome(raw: Record<string, unknown>): void {
    if (raw.type !== SessiondType.CloseOutcome || !isPositiveSafeInteger(raw.cid)) return;
    const pending = this._pendingCloseRequests.get(raw.cid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingCloseRequests.delete(raw.cid);
    let normalized = raw;
    if (pending.kind === 'confirm' && raw.closeStatus === 'failed' &&
      raw.failureCode === INVALID_CLOSE_TICKET_FAILURE && !hasValidCloseTarget(raw)) {
      normalized = { ...raw, ...pending.target };
    }
    if (isCloseOutcome(normalized)) pending.resolve(normalized);
    else pending.reject(new Error('The close service returned an invalid outcome.'));
  }

  private _resolvePendingAsClosed(cid: number, pending: PendingCloseRequest): void {
    clearTimeout(pending.timer);
    this._pendingCloseRequests.delete(cid);
    pending.resolve({ type: SessiondType.CloseOutcome, cid, ...pending.target, closeStatus: 'closed' });
  }

  private _rejectPendingCloseRequests(error: Error): void {
    for (const pending of this._pendingCloseRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingCloseRequests.clear();
  }

  private _resolvePendingPaneCWD(): void {
    for (const pending of this._pendingPaneCWD.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(undefined);
    }
    this._pendingPaneCWD.clear();
  }

  private _rejectPendingImagePastes(message: string): void {
    for (const pending of this._pendingImagePastes.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this._pendingImagePastes.clear();
  }

  private _open(): void {
    const ws = new WebSocket(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this.onReconnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      // Binary pane-data frame: [4-byte LE paneId][raw bytes].
      if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength >= 4) {
          const { paneId, data } = decodePaneFrame(ev.data);
          this._paneOutputCb?.(paneId, data);
        }
        return;
      }
      // Text frame — JSON control message
      if (typeof ev.data === 'string') {
    const raw = JSON.parse(ev.data) as Record<string, unknown>;
    this._resolveCloseOutcome(raw);
        const cid = typeof raw.cid === 'number' ? raw.cid : undefined;
        if (cid !== undefined) {
          const imagePaste = this._pendingImagePastes.get(cid);
          if (imagePaste) {
            clearTimeout(imagePaste.timeout);
            this._pendingImagePastes.delete(cid);
            if (raw.type === SessiondType.ImageSaved && typeof raw.path === 'string') {
              imagePaste.resolve(raw.path);
            } else {
              imagePaste.reject(new Error(typeof raw.error === 'string' ? raw.error : 'Image upload failed'));
            }
          }
          const pending = this._pendingPaneCWD.get(cid);
          if (pending) {
            clearTimeout(pending.timeout);
            this._pendingPaneCWD.delete(cid);
            pending.resolve(raw.type === SessiondType.PaneCWD && typeof raw.cwd === 'string'
              ? raw.cwd
              : undefined);
          }
          const pendingContext = this._pendingPaneContext.get(cid);
          if (pendingContext) {
            clearTimeout(pendingContext.timeout);
            this._pendingPaneContext.delete(cid);
            pendingContext.resolve(raw.type === SessiondType.PaneContext && typeof raw.paneId === 'number'
              ? { paneId: raw.paneId, cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
                  command: typeof raw.command === 'string' ? raw.command : undefined,
                  gitBranch: typeof raw.gitBranch === 'string' ? raw.gitBranch : undefined,
                  gitChanges: typeof raw.gitChanges === 'number' ? raw.gitChanges : 0 }
              : undefined);
          }
        }
        // Pass the raw message to control handlers (e.g. for detached/session-picker).
        // Non-typed envelopes (e.g. serve config) still flow through here.
        this._controlMessageCb?.(raw);
        // Flat sessiond messages carry a top-level "type" string; route them to
        // the sessiond hook. (Legacy single-key envelopes have no "type" field,
        // so the two paths never collide.)
        if (typeof raw.type === 'string') {
          this.onSessiondMessage?.(raw as unknown as SessiondMessage);
          // Relay-only types: dispatch as window CustomEvents so app.ts and
          // mux-dock can handle them without coupling to the socket directly.
          if (raw.type === SessiondType.BrowserAction) {
            window.dispatchEvent(new CustomEvent('browser-action', { detail: raw }));
          } else if (raw.type === SessiondType.LayoutCommand) {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          } else if (raw.type === SessiondType.PaneResized) {
            this.onPaneResized?.(raw.paneId as number, raw.cols as number, raw.rows as number);
          }
        }
      }
    };

  ws.onclose = (ev: CloseEvent) => {
    this._rejectPendingCloseRequests(new Error('The close outcome could not be confirmed because the connection was lost.'));
      this._resolvePendingPaneCWD();
      this._rejectPendingImagePastes('Terminal disconnected during image upload');
      if (ev.code === 1000 || this._intentionalClose) {
        return;
      }
      this.onDisconnect?.();
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // no-op — onclose fires after onerror
    };
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read clipboard image'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read clipboard image'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function buildWsUrl(path = '/ws'): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
