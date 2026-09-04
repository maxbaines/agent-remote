import type {
  CommandId,
  CommandRegistry,
  CommandShortcut,
  CommandState,
} from './command-registry.js';

export const KEYBINDINGS_STORAGE_KEY = 'just-terminal.keybindings.v1';

export interface EffectiveKeybinding {
  chord: string;
  label: string;
}

export interface ReservedKeybinding {
  chord: string;
  title: string;
}

export type KeybindingAssignment =
  | { ok: true }
  | { ok: false; message: string };

const MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift']);
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;
const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Semicolon: ';',
};
const KEY_ALIASES: Readonly<Record<string, string>> = {
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  '{': '[',
  '}': ']',
  '+': '=',
  _: '-',
  ':': ';',
  '<': ',',
};

function isMacOS(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function isPwa(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

function shortcutApplies(shortcut: CommandShortcut): boolean {
  if (shortcut.platform === 'macos' && !isMacOS()) return false;
  if (shortcut.platform === 'other' && isMacOS()) return false;
  return shortcut.scope === 'always' || isPwa();
}

export function chordFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  if (parts.length === 0) return null;
  parts.push(keyFromEvent(event));
  return parts.join('+');
}

/** Translate browser key names and shifted punctuation to cmux chord names. */
export function keyFromEvent(event: KeyboardEvent): string {
  if (event.code in CODE_KEYS) return CODE_KEYS[event.code]!;
  if (event.key === ' ') return 'space';
  const key = event.key.toLowerCase();
  return KEY_ALIASES[key] ?? key;
}

export function formatChord(chord: string): string {
  const names: Record<string, string> = {
    alt: 'Alt',
    ctrl: 'Ctrl',
    meta: 'Cmd',
    shift: 'Shift',
    space: 'Space',
  };
  return chord.split('+').map((part) => names[part] ?? part.toUpperCase()).join('+');
}

function normalizeChord(chord: string): string | null {
  const parts = chord.trim().toLowerCase().split('+').filter(Boolean);
  if (parts.length < 2) return null;
  const requestedKey = parts[parts.length - 1]!;
  const key = KEY_ALIASES[requestedKey] ?? requestedKey;
  const modifiers = new Set(parts.slice(0, -1));
  if ([...modifiers].some((part) => !MODIFIER_ORDER.includes(part as typeof MODIFIER_ORDER[number]))) {
    return null;
  }
  if (modifiers.size !== parts.length - 1 || modifiers.size === 0 || MODIFIER_ORDER.includes(key as typeof MODIFIER_ORDER[number])) {
    return null;
  }
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

/**
 * Owns editable Command Keybindings for this browser only. The Host config and
 * protocol never see these values; localStorage persistence is deliberately
 * origin-scoped and silently degrades to in-memory preferences when unavailable.
 */
export class BrowserKeybindings {
  readonly #overrides = new Map<CommandId, string>();

  constructor(
    private readonly registry: CommandRegistry,
    private readonly reserved: () => readonly ReservedKeybinding[] = () => [],
  ) {
    this.#restore();
  }

  bindingsFor(command: CommandState): readonly EffectiveKeybinding[] {
    const override = this.#overrides.get(command.id);
    if (override) return [{ chord: override, label: formatChord(override) }];
    return command.defaultShortcuts
      .filter(shortcutApplies)
      .map(({ chord, label }) => ({ chord, label }));
  }

  hasOverride(commandId: CommandId): boolean {
    return this.#overrides.has(commandId);
  }

  hasOverrides(): boolean {
    return this.#overrides.size > 0;
  }

  assign(commandId: CommandId, requestedChord: string): KeybindingAssignment {
    const command = this.registry.get(commandId);
    if (!command?.configurable) return { ok: false, message: 'This Command is not configurable.' };
    const chord = normalizeChord(requestedChord);
    if (!chord) return { ok: false, message: 'Use a shortcut with Ctrl, Alt, or Cmd.' };

    for (const other of this.registry.list()) {
      if (other.id === commandId) continue;
      if (this.bindingsFor(other).some((binding) => binding.chord === chord)) {
        return { ok: false, message: `${formatChord(chord)} is already assigned to ${other.title}.` };
      }
    }
    const reserved = this.reserved().find((binding) => normalizeChord(binding.chord) === chord);
    if (reserved) {
      return { ok: false, message: `${formatChord(chord)} is already assigned to ${reserved.title}.` };
    }

    this.#overrides.set(commandId, chord);
    this.#persist();
    return { ok: true };
  }

  reset(commandId: CommandId): void {
    if (!this.#overrides.delete(commandId)) return;
    this.#persist();
  }

  resetAll(): void {
    if (this.#overrides.size === 0) return;
    this.#overrides.clear();
    this.#persist();
  }

  #restore(): void {
    try {
      const stored = localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [id, value] of Object.entries(parsed)) {
        const command = this.registry.get(id as CommandId);
        const chord = typeof value === 'string' ? normalizeChord(value) : null;
        if (command?.configurable && chord) this.#overrides.set(command.id, chord);
      }
    } catch {
      // Private browsing, disabled storage, or malformed data: use defaults.
    }
  }

  #persist(): void {
    try {
      if (this.#overrides.size === 0) {
        localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
        return;
      }
      localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.#overrides)));
    } catch {
      // The in-memory edit still applies for this page when storage is unavailable.
    }
  }
}

/** Global capture handlers must stand down while the focused editor records. */
export function isRecordingKeybinding(event: KeyboardEvent): boolean {
  return event.composedPath().some(
    (target) => target instanceof HTMLElement && target.hasAttribute('data-keybinding-recorder'),
  );
}
