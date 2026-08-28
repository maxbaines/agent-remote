import type { Terminal, IBufferRange, IDecoration, ILink, IMarker } from '@xterm/xterm';

export const TERMINAL_FILE_OPEN_EVENT = 'terminal-file-open' as const;

export interface TerminalFileOpenDetail {
  paneId: number;
  path: string;
  cwd?: string;
  line?: number;
  column?: number;
}

interface ParsedFileLink {
  path: string;
  line?: number;
  column?: number;
}

const RAW_FILE_LINK_RE = /(?:file:\/\/[^\s<>"'`]+|(?:~\/|\.{1,2}\/|\/)[^\s<>"'`]+|(?:[\w@.+-]+\/)+[\w@.+-]+(?::\d+(?::\d+)?)?|[\w@+-]+\.(?:md|markdown|mdown|mkdn|txt|log|json|jsonl|ya?ml|toml|ini|conf|go|rs|py|rb|php|java|kt|kts|swift|c|cc|cpp|h|hpp|m|mm|cs|fs|js|jsx|mjs|cjs|ts|tsx|css|scss|sass|less|html?|vue|svelte|sh|bash|zsh|fish|sql|graphql|proto|xml|png|jpe?g|gif|webp|avif|bmp|ico)(?::\d+(?::\d+)?)?)/gi;

function trimTerminalPunctuation(value: string): string {
  let result = value.replace(/^[`'"(<[]+/, '');
  while (/[`'",;!?\])}>.]$/.test(result)) result = result.slice(0, -1);
  return result;
}

export function parseTerminalFileLink(value: string): ParsedFileLink | null {
  let candidate = trimTerminalPunctuation(value.trim());
  if (!candidate || /^https?:\/\//i.test(candidate)) return null;

  let line: number | undefined;
  let column: number | undefined;
  const hashLocation = candidate.match(/#L(\d+)(?:C(\d+))?$/i);
  const colonLocation = candidate.match(/:(\d+)(?::(\d+))?$/);
  const location = hashLocation ?? colonLocation;
  if (location) {
    line = Number(location[1]);
    column = location[2] ? Number(location[2]) : undefined;
    candidate = candidate.slice(0, -location[0].length);
  }

  if (candidate.startsWith('file://')) {
    try {
      const url = new URL(candidate);
      candidate = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }

  if (!candidate || candidate.endsWith('/')) return null;
  return { path: candidate, line, column };
}

export function parseTerminalCWD(value: string): string | undefined {
  let candidate = value.trim();
  if (candidate.startsWith('CurrentDir=')) candidate = candidate.slice('CurrentDir='.length);
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'file:' && url.protocol !== 'kitty-shell-cwd:') return undefined;
    return decodeURIComponent(url.pathname);
  } catch {
    return candidate.startsWith('/') ? candidate : undefined;
  }
}

function requestFileOpen(
  event: MouseEvent,
  value: string,
  paneId: number,
  getCWD: () => string | undefined,
  clearSelection: () => void,
): boolean {
  if (!event.shiftKey) return false;
  const link = parseTerminalFileLink(value);
  if (!link) return false;
  event.preventDefault();
  event.stopPropagation();
  // xterm treats Shift-mousedown as an incremental text selection before its
  // linkifier activates the link on mouseup. Undo that selection only after we
  // know this was a valid file-link activation; Shift-clicks elsewhere retain
  // xterm's normal selection behavior.
  clearSelection();
  window.dispatchEvent(new CustomEvent<TerminalFileOpenDetail>(TERMINAL_FILE_OPEN_EVENT, {
    detail: { paneId, cwd: getCWD(), ...link },
  }));
  return true;
}

function openWebLink(uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  window.open(uri, '_blank', 'noopener');
}

interface HoverColor {
  decoration?: IDecoration;
  marker: IMarker;
}

function addHoverColor(term: Terminal, range: IBufferRange): HoverColor | undefined {
  if (range.start.y !== range.end.y) return undefined;
  const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY;
  const marker = term.registerMarker(range.start.y - 1 - cursorLine);
  const foregroundColor = term.options.theme?.brightBlue ?? term.options.theme?.blue ?? '#0a84ff';
  const decoration = term.registerDecoration({
    marker,
    x: range.start.x - 1,
    width: range.end.x - range.start.x + 1,
    foregroundColor,
    layer: 'bottom',
  });
  return { marker, decoration };
}

function removeHoverColor(color: HoverColor | undefined): void {
  color?.decoration?.dispose();
  color?.marker.dispose();
}

/**
 * Installs both OSC 8 and plain-text file link handling on a terminal. File
 * links activate only on Shift-click; ordinary HTTP links retain their normal
 * browser behavior.
 */
export function registerTerminalFileLinks(
  term: Terminal,
  paneId: number,
  getCWD: () => string | undefined,
): void {
  let oscHoverColor: HoverColor | undefined;
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      if (requestFileOpen(event, uri, paneId, getCWD, () => term.clearSelection())) return;
      openWebLink(uri);
    },
    hover: (_event, uri, range) => {
      if (!parseTerminalFileLink(uri)) return;
      removeHoverColor(oscHoverColor);
      oscHoverColor = addHoverColor(term, range);
    },
    leave: () => {
      removeHoverColor(oscHoverColor);
      oscHoverColor = undefined;
    },
  };

  term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
      if (!line) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      RAW_FILE_LINK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RAW_FILE_LINK_RE.exec(line)) !== null) {
        // An absolute-looking "/host/path" substring inside an HTTP URL must
        // remain owned by WebLinksAddon, which is a lower-priority provider.
        if (/https?:$/i.test(line.slice(0, match.index))) continue;
        const text = trimTerminalPunctuation(match[0]);
        const parsed = parseTerminalFileLink(text);
        if (!parsed) continue;
        const start = match.index + match[0].indexOf(text);
        const range: IBufferRange = {
          start: { x: start + 1, y: bufferLineNumber },
          end: { x: start + text.length, y: bufferLineNumber },
        };
        const decorations = { pointerCursor: false, underline: false };
        let hoverColor: HoverColor | undefined;
        links.push({
          text,
          range,
          decorations,
          activate: (event, activatedText) => {
            requestFileOpen(event, activatedText, paneId, getCWD, () => term.clearSelection());
          },
          hover: (event) => {
            decorations.pointerCursor = event.shiftKey;
            decorations.underline = true;
            hoverColor = addHoverColor(term, range);
          },
          leave: () => {
            decorations.pointerCursor = false;
            decorations.underline = false;
            removeHoverColor(hoverColor);
            hoverColor = undefined;
          },
          dispose: () => {
            removeHoverColor(hoverColor);
            hoverColor = undefined;
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}
