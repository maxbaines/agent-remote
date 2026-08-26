import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  RefreshCw,
  X,
} from 'lucide';
import { icon } from '../lib/icons.js';

interface FileTreeEntry {
  name: string;
  path: string;
  directory: boolean;
}

interface FileTreeGit {
  branch: string;
  ahead?: number;
  behind?: number;
  files: Record<string, string>;
}

interface FileTreeResponse {
  root: string;
  path: string;
  entries: FileTreeEntry[];
  git?: FileTreeGit;
}

interface FileTreeNode extends FileTreeEntry {
  expanded: boolean;
  loading: boolean;
  children?: FileTreeNode[];
  error?: string;
}

type GitDecoration = {
  kind: 'added' | 'conflict' | 'deleted' | 'modified' | 'renamed' | 'untracked';
  label: string;
  title: string;
};

const REFRESH_INTERVAL_MS = 5_000;

@customElement('file-tree-sidebar')
export class FileTreeSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 0 0 clamp(220px, 23vw, 292px);
      flex-direction: column;
      width: clamp(220px, 23vw, 292px);
      min-width: 220px;
      max-width: 292px;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      box-sizing: border-box;
      background: var(--chrome-bar);
      border-left: 1px solid var(--chrome-border);
      color: var(--chrome-text-bright);
      user-select: none;
    }

    .header {
      min-height: 36px;
      padding: 0 6px 0 11px;
      border-bottom: 1px solid var(--chrome-border);
      display: flex;
      align-items: center;
      gap: 6px;
      box-sizing: border-box;
    }

    .title {
      flex: 1;
      min-width: 0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--chrome-text-dim);
    }

    .action {
      width: 25px;
      height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--chrome-text-dim);
      cursor: pointer;
    }

    .action:hover,
    .action.active {
      color: var(--chrome-text-bright);
      background: var(--chrome-hover);
    }

    .action.refreshing svg {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .root-bar {
      min-height: 47px;
      padding: 6px 10px 7px;
      border-bottom: 1px solid var(--chrome-border);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
    }

    .root-line,
    .git-line {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 5px;
    }

    .root-name {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12.5px;
      font-weight: 600;
    }

    .root-path {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 10.5px;
      color: var(--chrome-text-dim);
    }

    .branch {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 10.5px;
      color: var(--chrome-text-dim);
    }

    .dirty-count,
    .sync-count {
      flex-shrink: 0;
      font-size: 10px;
      color: var(--mux-warn);
    }

    .tree {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 5px 0 10px;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--chrome-text-dim) 32%, transparent) transparent;
    }

    .row {
      height: 24px;
      padding-right: 8px;
      display: flex;
      align-items: center;
      gap: 5px;
      box-sizing: border-box;
      outline: none;
      cursor: default;
      font-size: 12px;
      color: var(--chrome-text-bright);
    }

    .row:hover,
    .row:focus-visible {
      background: var(--chrome-hover);
    }

    .row.file {
      cursor: pointer;
    }

    .twisty {
      width: 12px;
      flex: 0 0 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--chrome-text-dim);
    }

    .file-icon {
      display: inline-flex;
      align-items: center;
      color: var(--chrome-text-dim);
      flex-shrink: 0;
    }

    .directory > .file-icon {
      color: color-mix(in srgb, var(--mux-warn) 76%, var(--chrome-text-bright));
    }

    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .git-badge {
      flex: 0 0 14px;
      text-align: right;
      font-size: 10px;
      font-weight: 700;
    }

    .git-added { color: var(--mux-ok); }
    .git-conflict, .git-deleted { color: var(--mux-error); }
    .git-modified, .git-renamed { color: var(--mux-warn); }
    .git-untracked { color: var(--chrome-text-dim); }

    .status,
    .inline-error {
      padding: 14px 12px;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--chrome-text-dim);
      user-select: text;
    }

    .status.error,
    .inline-error {
      color: var(--mux-error);
    }

    .inline-error {
      padding: 3px 10px 5px 30px;
    }

    .lucide-icon {
      display: inline-block;
      flex-shrink: 0;
      pointer-events: none;
    }
  `;

  @property({ type: Number }) paneId = 0;
  @property({ type: String }) workspaceId = '';
  @property({ attribute: false }) cwdProvider?: (paneId: number) => Promise<string | undefined>;

  @state() private _nodes: FileTreeNode[] = [];
  @state() private _root = '';
  @state() private _cwd = '';
  @state() private _git?: FileTreeGit;
  @state() private _loading = true;
  @state() private _refreshing = false;
  @state() private _showHidden = false;
  @state() private _error = '';

  private _refreshTimer?: ReturnType<typeof setInterval>;
  private _requestGeneration = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this._refreshTimer = setInterval(() => void this._resolveAndLoad(false), REFRESH_INTERVAL_MS);
  }

  override disconnectedCallback(): void {
    if (this._refreshTimer !== undefined) clearInterval(this._refreshTimer);
    this._refreshTimer = undefined;
    this._requestGeneration++;
    super.disconnectedCallback();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('paneId') || changed.has('workspaceId') || changed.has('cwdProvider')) {
      void this._resolveAndLoad(true);
    }
  }

  private async _resolveAndLoad(reset: boolean): Promise<void> {
    if (!this.cwdProvider || this.paneId <= 0) {
      if (this.paneId <= 0) {
        this._requestGeneration++;
        this._refreshing = false;
        this._loading = false;
        this._root = '';
        this._nodes = [];
        this._error = 'Select a terminal pane to browse its files.';
      }
      return;
    }

    // Pane/workspace changes must supersede an in-flight background refresh.
    // Routine polling, on the other hand, is coalesced to one request.
    if (this._refreshing && !reset) return;

    const generation = reset ? ++this._requestGeneration : this._requestGeneration;
    this._refreshing = true;
    if (reset) this._loading = true;
    try {
      const cwd = await this.cwdProvider(this.paneId);
      if (generation !== this._requestGeneration) return;
      if (!cwd) throw new Error('Could not resolve the active pane working directory.');
      const response = await this._fetchTree(cwd);
      if (generation !== this._requestGeneration) return;
      const rootChanged = response.root !== this._root;
      this._cwd = cwd;
      this._root = response.root;
      this._git = response.git;
      this._nodes = rootChanged || reset
        ? this._makeNodes(response.entries)
        : this._mergeNodes(this._nodes, response.entries);
      this._error = '';
    } catch (error) {
      if (generation !== this._requestGeneration) return;
      this._error = error instanceof Error ? error.message : 'Could not load files.';
      if (reset) {
        this._root = '';
        this._nodes = [];
      }
    } finally {
      if (generation === this._requestGeneration) {
        this._loading = false;
        this._refreshing = false;
      }
    }
  }

  private async _fetchTree(cwd: string, path?: string): Promise<FileTreeResponse> {
    const query = new URLSearchParams({ cwd });
    if (path) query.set('path', path);
    if (this._showHidden) query.set('hidden', '1');
    const response = await fetch(`/api/file-tree?${query}`, { cache: 'no-store' });
    if (!response.ok) {
      const message = (await response.text()).trim();
      throw new Error(message || `Could not load files (${response.status}).`);
    }
    return response.json() as Promise<FileTreeResponse>;
  }

  private _makeNodes(entries: FileTreeEntry[]): FileTreeNode[] {
    return entries.map((entry) => ({ ...entry, expanded: false, loading: false }));
  }

  private _mergeNodes(current: FileTreeNode[], entries: FileTreeEntry[]): FileTreeNode[] {
    const byPath = new Map(current.map((node) => [node.path, node]));
    return entries.map((entry) => {
      const existing = byPath.get(entry.path);
      if (existing) {
        Object.assign(existing, entry);
        return existing;
      }
      return { ...entry, expanded: false, loading: false };
    });
  }

  private async _toggleDirectory(node: FileTreeNode): Promise<void> {
    if (node.expanded) {
      node.expanded = false;
      this._nodes = [...this._nodes];
      return;
    }
    node.expanded = true;
    node.error = undefined;
    if (node.children !== undefined) {
      this._nodes = [...this._nodes];
      return;
    }
    node.loading = true;
    this._nodes = [...this._nodes];
    const generation = this._requestGeneration;
    try {
      const response = await this._fetchTree(this._cwd, node.path);
      if (generation !== this._requestGeneration) return;
      node.children = this._makeNodes(response.entries);
      this._git = response.git;
    } catch (error) {
      if (generation !== this._requestGeneration) return;
      node.error = error instanceof Error ? error.message : 'Could not read directory.';
      node.children = [];
    } finally {
      if (generation === this._requestGeneration) {
        node.loading = false;
        this._nodes = [...this._nodes];
      }
    }
  }

  private _onNodeKeyDown(event: KeyboardEvent, node: FileTreeNode): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (node.directory) {
      void this._toggleDirectory(node);
    } else {
      this._openFile(node);
    }
  }

  private _openFile(node: FileTreeNode): void {
    this.dispatchEvent(new CustomEvent('file-open', {
      detail: { path: node.path },
      bubbles: true,
      composed: true,
    }));
  }

  private _toggleHidden(): void {
    this._showHidden = !this._showHidden;
    void this._resolveAndLoad(true);
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent('file-tree-toggle', { bubbles: true, composed: true }));
  }

  private _relativePath(path: string): string {
    if (!this._root || path === this._root) return '';
    const prefix = this._root.endsWith('/') ? this._root : `${this._root}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  private _gitDecoration(node: FileTreeNode): GitDecoration | undefined {
    const files = this._git?.files ?? {};
    const relative = this._relativePath(node.path).replaceAll('\\', '/');
    if (!relative) return undefined;
    if (!node.directory) return this._decorationForStatus(files[relative]);
    const prefix = `${relative}/`;
    const descendants = Object.entries(files).filter(([path]) => path.startsWith(prefix));
    if (descendants.length === 0) return undefined;
    const decoration = descendants
      .map(([, status]) => this._decorationForStatus(status))
      .filter((item): item is GitDecoration => !!item)
      .sort((a, b) => this._decorationPriority(b.kind) - this._decorationPriority(a.kind))[0];
    return decoration ? { ...decoration, label: '•', title: `${descendants.length} changed file${descendants.length === 1 ? '' : 's'}` } : undefined;
  }

  private _decorationForStatus(status?: string): GitDecoration | undefined {
    if (!status) return undefined;
    if (status === '??') return { kind: 'untracked', label: 'U', title: 'Untracked' };
    if (status.includes('U') || status === 'AA' || status === 'DD') {
      return { kind: 'conflict', label: '!', title: 'Merge conflict' };
    }
    if (status.includes('D')) return { kind: 'deleted', label: 'D', title: 'Deleted' };
    if (status.includes('R') || status.includes('C')) return { kind: 'renamed', label: 'R', title: 'Renamed' };
    if (status.includes('A')) return { kind: 'added', label: 'A', title: 'Added' };
    if (status.includes('M')) return { kind: 'modified', label: 'M', title: 'Modified' };
    return undefined;
  }

  private _decorationPriority(kind: GitDecoration['kind']): number {
    return { conflict: 6, deleted: 5, renamed: 4, added: 3, modified: 2, untracked: 1 }[kind];
  }

  private _renderNodes(nodes: FileTreeNode[], depth = 0): TemplateResult[] {
    return nodes.map((node) => {
      const decoration = this._gitDecoration(node);
      return html`
        <div
          class="row ${node.directory ? 'directory' : 'file'} ${decoration ? `git-${decoration.kind}` : ''}"
          style="padding-left: ${6 + depth * 14}px"
          title="${node.path}"
          tabindex="0"
          @click="${() => node.directory ? void this._toggleDirectory(node) : this._openFile(node)}"
          @keydown="${(event: KeyboardEvent) => this._onNodeKeyDown(event, node)}"
        >
          <span class="twisty">
            ${node.directory
              ? icon(node.expanded ? ChevronDown : ChevronRight, { size: 12 })
              : nothing}
          </span>
          <span class="file-icon">
            ${icon(node.directory ? (node.expanded ? FolderOpen : Folder) : File, { size: 14 })}
          </span>
          <span class="name">${node.name}</span>
          ${decoration
            ? html`<span class="git-badge" title="${decoration.title}">${decoration.label}</span>`
            : nothing}
        </div>
        ${node.expanded
          ? html`
              ${node.loading ? html`<div class="inline-error">Loading…</div>` : nothing}
              ${node.error ? html`<div class="inline-error">${node.error}</div>` : nothing}
              ${node.children ? this._renderNodes(node.children, depth + 1) : nothing}
            `
          : nothing}
      `;
    });
  }

  private _basename(path: string): string {
    const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
    return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
  }

  override render() {
    const dirtyCount = Object.keys(this._git?.files ?? {}).length;
    const sync = [
      this._git?.ahead ? `↑${this._git.ahead}` : '',
      this._git?.behind ? `↓${this._git.behind}` : '',
    ].filter(Boolean).join(' ');
    return html`
      <div class="header">
        <span class="title">FILES</span>
        <button
          class="action ${this._showHidden ? 'active' : ''}"
          title="${this._showHidden ? 'Hide hidden files' : 'Show hidden files'}"
          @click="${this._toggleHidden}"
        >${icon(this._showHidden ? EyeOff : Eye, { size: 14 })}</button>
        <button
          class="action ${this._refreshing ? 'refreshing' : ''}"
          title="Refresh files and Git status"
          @click="${() => void this._resolveAndLoad(false)}"
        >${icon(RefreshCw, { size: 14 })}</button>
        <button class="action" title="Close file tree" @click="${this._close}">
          ${icon(X, { size: 15 })}
        </button>
      </div>
      ${this._root
        ? html`
            <div class="root-bar" title="${this._root}">
              <div class="root-line">
                <span class="root-name">${this._basename(this._root)}</span>
                <span class="root-path">${this._root}</span>
              </div>
              ${this._git
                ? html`
                    <div class="git-line">
                      ${icon(GitBranch, { size: 11 })}
                      <span class="branch">${this._git.branch || 'Git worktree'}</span>
                      ${sync ? html`<span class="sync-count">${sync}</span>` : nothing}
                      ${dirtyCount ? html`<span class="dirty-count">${dirtyCount} changed</span>` : nothing}
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
      <div class="tree">
        ${this._loading
          ? html`<div class="status">Loading files…</div>`
          : this._error
            ? html`<div class="status error">${this._error}</div>`
            : this._nodes.length === 0
              ? html`<div class="status">This directory is empty.</div>`
              : this._renderNodes(this._nodes)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'file-tree-sidebar': FileTreeSidebar;
  }
}
