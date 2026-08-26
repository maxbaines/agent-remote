import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  PanelUpdateEvent,
} from 'dockview-core';

export interface FileViewerRequest {
  path: string;
  cwd?: string;
  line?: number;
  column?: number;
}

interface FileResponse {
  path: string;
  content: string;
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkdn)$/i.test(path);
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export class FileViewerRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _kind: 'markdown' | 'text';
  private _request: FileViewerRequest | null = null;
  private _abort: AbortController | null = null;

  constructor(kind: 'markdown' | 'text') {
    this._kind = kind;
    const element = document.createElement('div');
    element.className = `mux-file-viewer mux-file-viewer-${kind}`;
    this.element = element;
  }

  init(parameters: GroupPanelPartInitParameters): void {
    this._request = parameters.params as FileViewerRequest;
    void this._load();
  }

  layout(): void {}

  update(event: PanelUpdateEvent): void {
    this._request = { ...(this._request ?? { path: '' }), ...event.params } as FileViewerRequest;
    void this._load();
  }

  focus(): void {
    this.element.querySelector<HTMLElement>('.mux-file-viewer-scroll')?.focus();
  }

  dispose(): void {
    this._abort?.abort();
    this._abort = null;
  }

  private async _load(): Promise<void> {
    const request = this._request;
    if (!request) return;
    this._abort?.abort();
    this._abort = new AbortController();
    this._renderStatus('Loading…');

    const query = new URLSearchParams({ path: request.path });
    if (request.cwd) query.set('cwd', request.cwd);
    try {
      const response = await fetch(`/api/files?${query}`, {
        signal: this._abort.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(message || `Could not open file (${response.status})`);
      }
      const body = await response.json() as FileResponse;
      this._renderFile(body);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this._renderStatus(error instanceof Error ? error.message : 'Could not open file', true);
    }
  }

  private _renderChrome(path: string): { scroller: HTMLElement; body: HTMLElement } {
    this.element.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'mux-file-viewer-toolbar';

    const pathLabel = document.createElement('span');
    pathLabel.className = 'mux-file-viewer-path';
    pathLabel.textContent = path;
    pathLabel.title = path;

    const mode = document.createElement('span');
    mode.className = 'mux-file-viewer-mode';
    mode.textContent = this._kind === 'markdown' ? 'Markdown' : 'Text';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'mux-file-viewer-reload';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => void this._load());
    toolbar.append(pathLabel, mode, reload);

    const scroller = document.createElement('div');
    scroller.className = 'mux-file-viewer-scroll';
    scroller.tabIndex = 0;
    const body = document.createElement('div');
    body.className = 'mux-file-viewer-body';
    scroller.appendChild(body);
    this.element.append(toolbar, scroller);
    return { scroller, body };
  }

  private _renderFile(file: FileResponse): void {
    const { scroller, body } = this._renderChrome(file.path);
    if (this._kind === 'markdown' || isMarkdownPath(file.path)) {
      body.classList.add('mux-markdown-body');
      const rendered = marked.parse(file.content, { async: false }) as string;
      body.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
      for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        link.rel = 'noopener noreferrer';
        if (/^https?:\/\//i.test(link.href)) link.target = '_blank';
      }
      return;
    }

    body.classList.add('mux-text-body');
    const lines = file.content.split('\n');
    const list = document.createElement('ol');
    list.className = 'mux-file-lines';
    const selectedLine = Math.min(Math.max(this._request?.line ?? 0, 0), lines.length);
    let selectedElement: HTMLLIElement | null = null;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index++) {
      const item = document.createElement('li');
      item.className = 'mux-file-line';
      item.value = index + 1;
      const code = document.createElement('code');
      code.textContent = lines[index] || '\u200b';
      item.appendChild(code);
      if (index + 1 === selectedLine) {
        item.classList.add('mux-file-line-selected');
        selectedElement = item;
      }
      fragment.appendChild(item);
    }
    list.appendChild(fragment);
    body.appendChild(list);
    if (selectedElement) {
      requestAnimationFrame(() => selectedElement?.scrollIntoView({ block: 'center' }));
    } else {
      scroller.scrollTop = 0;
    }
  }

  private _renderStatus(message: string, error = false): void {
    this.element.replaceChildren();
    const status = document.createElement('div');
    status.className = `mux-file-viewer-status${error ? ' error' : ''}`;
    const title = document.createElement('strong');
    title.textContent = error ? 'Unable to open file' : message;
    status.appendChild(title);
    if (error && this._request) {
      const detail = document.createElement('span');
      detail.textContent = message;
      const path = document.createElement('code');
      path.textContent = this._request.path;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => void this._load());
      status.append(detail, path, retry);
    }
    this.element.appendChild(status);
  }
}

export { basename, isMarkdownPath };
