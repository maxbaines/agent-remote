export type MobileModifier = 'ctrl' | 'alt' | 'meta';

export type MobileTerminalKey =
  | 'escape'
  | 'tab'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'pipe'
  | 'slash'
  | 'tilde';

export interface MobileInputTarget {
  workspaceId: string;
  paneId: number;
}

export interface MobileInputResult {
  data?: string;
  shortcut?: { key: string; metaKey: boolean };
}

export interface MobilePlatform {
  mobile: boolean;
  ios: boolean;
  android: boolean;
}

interface ActiveModifier extends MobileInputTarget {
  modifier: MobileModifier;
}

const ARROW_KEYS: Record<Extract<MobileTerminalKey, `arrow-${string}`>, string> = {
  'arrow-up': 'ArrowUp',
  'arrow-down': 'ArrowDown',
  'arrow-left': 'ArrowLeft',
  'arrow-right': 'ArrowRight',
};

/**
 * Detect the mobile operating systems that need a software-keyboard accessory
 * bar. iPadOS can identify itself as macOS, so touch capability is part of the
 * iPad check. Keeping this OS-scoped (rather than width-scoped) lets an iPad in
 * wide layout receive the bar without exposing it on desktop PWAs.
 */
export function detectMobilePlatform(): MobilePlatform {
  if (typeof navigator === 'undefined') return { mobile: false, ios: false, android: false };

  const ua = navigator.userAgent;
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const ios = /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/i.test(ua) && touchPoints > 1);
  const android = /Android/i.test(ua);

  return { mobile: touchPoints > 0 && (ios || android), ios, android };
}

function sameTarget(a: MobileInputTarget, b: MobileInputTarget): boolean {
  return a.workspaceId === b.workspaceId && a.paneId === b.paneId;
}

function firstCodePoint(data: string): { first: string; rest: string } {
  const first = String.fromCodePoint(data.codePointAt(0)!);
  return { first, rest: data.slice(first.length) };
}

function ctrlCharacter(character: string): string | null {
  if (character === ' ') return '\x00';
  if (character === '?') return '\x7f';
  if (character === '|') return '\x1c';
  if (character === '~') return '\x1e';
  if (character === '/') return '\x1f';

  const code = character.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  return null;
}

function baseKeyData(key: MobileTerminalKey, applicationCursorKeysMode: boolean): string {
  switch (key) {
    case 'escape': return '\x1b';
    case 'tab': return '\t';
    case 'pipe': return '|';
    case 'slash': return '/';
    case 'tilde': return '~';
    case 'arrow-up': return applicationCursorKeysMode ? '\x1bOA' : '\x1b[A';
    case 'arrow-down': return applicationCursorKeysMode ? '\x1bOB' : '\x1b[B';
    case 'arrow-right': return applicationCursorKeysMode ? '\x1bOC' : '\x1b[C';
    case 'arrow-left': return applicationCursorKeysMode ? '\x1bOD' : '\x1b[D';
  }
}

function modifiedArrow(key: Extract<MobileTerminalKey, `arrow-${string}`>, modifier: MobileModifier): string {
  const final = {
    'arrow-up': 'A',
    'arrow-down': 'B',
    'arrow-right': 'C',
    'arrow-left': 'D',
  }[key];
  const parameter = modifier === 'ctrl' ? 5 : 3;
  return `\x1b[1;${parameter}${final}`;
}

function shortcutKey(key: MobileTerminalKey): string {
  switch (key) {
    case 'escape': return 'Escape';
    case 'tab': return 'Tab';
    case 'arrow-up': return ARROW_KEYS[key];
    case 'arrow-down': return ARROW_KEYS[key];
    case 'arrow-left': return ARROW_KEYS[key];
    case 'arrow-right': return ARROW_KEYS[key];
    case 'pipe': return '|';
    case 'slash': return '/';
    case 'tilde': return '~';
  }
}

/**
 * One-shot modifier state shared by the toolbar and xterm's onData path.
 * Ctrl/Alt transform terminal bytes; Cmd deliberately becomes a browser-local
 * shortcut and never leaks into the PTY.
 */
class MobileTerminalInputController {
  #active: ActiveModifier | null = null;
  #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  modifierFor(target: MobileInputTarget): MobileModifier | null {
    return this.#active && sameTarget(this.#active, target) ? this.#active.modifier : null;
  }

  toggle(target: MobileInputTarget, modifier: MobileModifier): void {
    if (this.#active && sameTarget(this.#active, target) && this.#active.modifier === modifier) {
      this.#active = null;
    } else {
      this.#active = { ...target, modifier };
    }
    this.#notify();
  }

  clear(target?: MobileInputTarget): void {
    if (!this.#active) return;
    if (target && !sameTarget(this.#active, target)) return;
    this.#active = null;
    this.#notify();
  }

  transformText(target: MobileInputTarget, data: string): MobileInputResult {
    const modifier = this.modifierFor(target);
    if (!modifier || data.length === 0) return { data };

    this.clear(target);
    const { first, rest } = firstCodePoint(data);

    if (modifier === 'meta') {
      return { shortcut: { key: first, metaKey: true } };
    }
    if (modifier === 'alt') return { data: `\x1b${first}${rest}` };

    const control = ctrlCharacter(first);
    return { data: control === null ? data : `${control}${rest}` };
  }

  encodeKey(
    target: MobileInputTarget,
    key: MobileTerminalKey,
    applicationCursorKeysMode: boolean,
  ): MobileInputResult {
    const modifier = this.modifierFor(target);
    if (modifier) this.clear(target);

    const arrowKey = key.startsWith('arrow-')
      ? key as Extract<MobileTerminalKey, `arrow-${string}`>
      : null;

    if (modifier === 'meta') {
      return { shortcut: { key: shortcutKey(key), metaKey: true } };
    }
    if (arrowKey && modifier) return { data: modifiedArrow(arrowKey, modifier) };

    const data = baseKeyData(key, applicationCursorKeysMode);
    if (modifier === 'alt') return { data: `\x1b${data}` };
    if (modifier === 'ctrl') {
      const control = ctrlCharacter(data);
      return { data: control ?? data };
    }
    return { data };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const mobileTerminalInput = new MobileTerminalInputController();
