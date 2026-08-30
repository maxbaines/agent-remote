import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
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

interface CodeLanguage {
  id: string;
  label: string;
}

const CODE_LANGUAGES = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java,
  javascript, json, kotlin, makefile, php, python, ruby, rust, scss, sql,
  swift, typescript, xml, yaml,
};

for (const [name, language] of Object.entries(CODE_LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

const CODE_EXTENSIONS: Record<string, CodeLanguage> = {
  bash: { id: 'bash', label: 'Bash' },
  c: { id: 'c', label: 'C' },
  cc: { id: 'cpp', label: 'C++' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  conf: { id: 'ini', label: 'Config' },
  cpp: { id: 'cpp', label: 'C++' },
  cs: { id: 'csharp', label: 'C#' },
  csh: { id: 'bash', label: 'Shell' },
  css: { id: 'css', label: 'CSS' },
  cts: { id: 'typescript', label: 'TypeScript' },
  diff: { id: 'diff', label: 'Diff' },
  env: { id: 'ini', label: 'Environment' },
  go: { id: 'go', label: 'Go' },
  gql: { id: 'graphql', label: 'GraphQL' },
  graphql: { id: 'graphql', label: 'GraphQL' },
  h: { id: 'c', label: 'C' },
  hh: { id: 'cpp', label: 'C++' },
  hpp: { id: 'cpp', label: 'C++' },
  htm: { id: 'xml', label: 'HTML' },
  html: { id: 'xml', label: 'HTML' },
  ini: { id: 'ini', label: 'INI' },
  java: { id: 'java', label: 'Java' },
  js: { id: 'javascript', label: 'JavaScript' },
  json: { id: 'json', label: 'JSON' },
  jsonl: { id: 'json', label: 'JSON Lines' },
  jsx: { id: 'javascript', label: 'JSX' },
  kt: { id: 'kotlin', label: 'Kotlin' },
  kts: { id: 'kotlin', label: 'Kotlin' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  mts: { id: 'typescript', label: 'TypeScript' },
  php: { id: 'php', label: 'PHP' },
  py: { id: 'python', label: 'Python' },
  rb: { id: 'ruby', label: 'Ruby' },
  rs: { id: 'rust', label: 'Rust' },
  scss: { id: 'scss', label: 'SCSS' },
  sh: { id: 'bash', label: 'Shell' },
  sql: { id: 'sql', label: 'SQL' },
  svelte: { id: 'xml', label: 'Svelte' },
  svg: { id: 'xml', label: 'SVG' },
  swift: { id: 'swift', label: 'Swift' },
  toml: { id: 'ini', label: 'TOML' },
  ts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'typescript', label: 'TSX' },
  vue: { id: 'xml', label: 'Vue' },
  xml: { id: 'xml', label: 'XML' },
  yaml: { id: 'yaml', label: 'YAML' },
  yml: { id: 'yaml', label: 'YAML' },
  zsh: { id: 'bash', label: 'Shell' },
};

const CODE_FILENAMES: Record<string, CodeLanguage> = {
  dockerfile: { id: 'dockerfile', label: 'Dockerfile' },
  gemfile: { id: 'ruby', label: 'Ruby' },
  makefile: { id: 'makefile', label: 'Makefile' },
};

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkdn)$/i.test(path);
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path);
}

function isHtmlPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path);
}

function codeLanguageForPath(path: string): CodeLanguage | null {
  const name = basename(path).toLowerCase();
  const namedLanguage = CODE_FILENAMES[name];
  if (namedLanguage) return namedLanguage;
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return CODE_EXTENSIONS[extension] ?? null;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export class FileViewerRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private readonly _kind: 'html' | 'markdown' | 'text' | 'image';
  private _htmlView: 'rendered' | 'text' = 'rendered';
  private _request: FileViewerRequest | null = null;
  private _abort: AbortController | null = null;

  constructor(kind: 'html' | 'markdown' | 'text' | 'image') {
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
    if (this._kind === 'image' || isImagePath(request.path)) query.set('format', 'image');
    try {
      const response = await fetch(`/api/files?${query}`, {
        signal: this._abort.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const message = (await response.text()).trim();
        throw new Error(message || `Could not open file (${response.status})`);
      }
      if (this._kind === 'image' || isImagePath(request.path)) {
        this._renderImage(request.path, await response.blob());
      } else {
        const body = await response.json() as FileResponse;
        this._renderFile(body);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this._renderStatus(error instanceof Error ? error.message : 'Could not open file', true);
    }
  }

  private _renderImage(path: string, blob: Blob): void {
    const { body } = this._renderChrome(path, 'Image');
    body.classList.add('mux-image-body');
    const image = document.createElement('img');
    image.className = 'mux-image-preview';
    image.alt = basename(path);
    const objectUrl = URL.createObjectURL(blob);
    image.src = objectUrl;
    image.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });
    image.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl);
      this._renderStatus('The image could not be decoded', true);
    }, { once: true });
    body.appendChild(image);
  }

  private _renderChrome(
    path: string,
    modeLabel: string,
    controls?: HTMLElement,
  ): { scroller: HTMLElement; body: HTMLElement } {
    this.element.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'mux-file-viewer-toolbar';

    const pathLabel = document.createElement('span');
    pathLabel.className = 'mux-file-viewer-path';
    pathLabel.textContent = path;
    pathLabel.title = path;

    const mode = document.createElement('span');
    mode.className = 'mux-file-viewer-mode';
    mode.textContent = modeLabel;

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'mux-file-viewer-reload';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => void this._load());
    toolbar.append(pathLabel, mode);
    if (controls) toolbar.appendChild(controls);
    toolbar.appendChild(reload);

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
    if (this._kind === 'html' || isHtmlPath(file.path)) {
      this._renderHtml(file);
      return;
    }

    if (this._kind === 'markdown' || isMarkdownPath(file.path)) {
      const { body } = this._renderChrome(file.path, 'Markdown');
      body.classList.add('mux-markdown-body');
      const rendered = marked.parse(file.content, { async: false }) as string;
      body.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
      for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        link.rel = 'noopener noreferrer';
        if (/^https?:\/\//i.test(link.href)) link.target = '_blank';
      }
      return;
    }

    this._renderText(file);
  }

  private _renderHtml(file: FileResponse): void {
    const toggle = document.createElement('div');
    toggle.className = 'mux-file-viewer-toggle';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'HTML preview mode');
    for (const view of ['rendered', 'text'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mux-file-viewer-toggle-button';
      button.textContent = view === 'rendered' ? 'Rendered' : 'Text';
      button.setAttribute('aria-pressed', String(this._htmlView === view));
      button.addEventListener('click', () => {
        if (this._htmlView === view) return;
        this._htmlView = view;
        this._renderHtml(file);
      });
      toggle.appendChild(button);
    }

    const { scroller, body } = this._renderChrome(file.path, 'HTML', toggle);
    if (this._htmlView === 'text') {
      this._renderTextContent(file, scroller, body);
      return;
    }

    scroller.classList.add('mux-html-scroll');
    body.classList.add('mux-html-body');
    const frame = document.createElement('iframe');
    frame.className = 'mux-html-preview';
    frame.title = `Rendered preview of ${basename(file.path)}`;
    // Scripts may run so generated reports and other self-contained static
    // documents render faithfully. Omitting allow-same-origin keeps that code
    // in an opaque origin, unable to reach JustTerminal's DOM or browser data.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = file.content;
    body.appendChild(frame);
  }

  private _renderText(file: FileResponse): void {
    const language = codeLanguageForPath(file.path);
    const { scroller, body } = this._renderChrome(file.path, language?.label ?? 'Text');
    this._renderTextContent(file, scroller, body, language);
  }

  private _renderTextContent(
    file: FileResponse,
    scroller: HTMLElement,
    body: HTMLElement,
    language = codeLanguageForPath(file.path),
  ): void {
    body.classList.add('mux-text-body');
    const lines = file.content.split('\n');
    const highlightedLines = language ? this._highlightLines(file.content, language.id) : null;
    const list = document.createElement('ol');
    list.className = `mux-file-lines${language ? ' mux-code-lines' : ''}`;
    const selectedLine = Math.min(Math.max(this._request?.line ?? 0, 0), lines.length);
    let selectedElement: HTMLLIElement | null = null;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index++) {
      const item = document.createElement('li');
      item.className = 'mux-file-line';
      item.value = index + 1;
      const code = document.createElement('code');
      if (highlightedLines) {
        code.append(...(highlightedLines[index] ?? []));
        if (!code.hasChildNodes()) code.textContent = '\u200b';
      } else {
        code.textContent = lines[index] || '\u200b';
      }
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

  private _highlightLines(content: string, language: string): DocumentFragment[][] {
    const highlighted = hljs.highlight(content, { language, ignoreIllegals: true });
    const source = document.createElement('code');
    source.innerHTML = DOMPurify.sanitize(highlighted.value, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
    });

    const lines: DocumentFragment[][] = [[]];
    const appendText = (text: string, classes: string[]): void => {
      const chunks = text.split('\n');
      for (let index = 0; index < chunks.length; index++) {
        if (index > 0) lines.push([]);
        if (!chunks[index]) continue;
        const fragment = document.createDocumentFragment();
        const node = classes.length > 0 ? document.createElement('span') : document.createTextNode(chunks[index]);
        if (node instanceof HTMLElement) {
          node.classList.add(...classes);
          node.textContent = chunks[index];
        }
        fragment.appendChild(node);
        lines[lines.length - 1].push(fragment);
      }
    };
    const visit = (node: Node, classes: string[]): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.textContent ?? '', classes);
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      const nextClasses = [...classes, ...node.classList];
      for (const child of node.childNodes) visit(child, nextClasses);
    };
    for (const node of source.childNodes) visit(node, []);
    return lines;
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

export { basename, isHtmlPath, isImagePath, isMarkdownPath };
