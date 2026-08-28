export const CREATE_TAB_COMMAND_ID = 'pane.create-tab' as const;
export const SPLIT_LEFT_COMMAND_ID = 'pane.split-left' as const;
export const SPLIT_RIGHT_COMMAND_ID = 'pane.split-right' as const;
export const SPLIT_UP_COMMAND_ID = 'pane.split-up' as const;
export const SPLIT_DOWN_COMMAND_ID = 'pane.split-down' as const;
export const CLEAR_TO_START_COMMAND_ID = 'terminal.clear-to-start' as const;
export const CREATE_WORKSPACE_COMMAND_ID = 'workspace.create' as const;
export const CREATE_CODEX_SESSION_COMMAND_ID = 'workspace.create-codex-session' as const;

export type DirectionalSplit = 'left' | 'right' | 'up' | 'down';
export type CommandId =
  | typeof CREATE_TAB_COMMAND_ID
  | typeof SPLIT_LEFT_COMMAND_ID
  | typeof SPLIT_RIGHT_COMMAND_ID
  | typeof SPLIT_UP_COMMAND_ID
  | typeof SPLIT_DOWN_COMMAND_ID
  | typeof CLEAR_TO_START_COMMAND_ID
  | typeof CREATE_WORKSPACE_COMMAND_ID
  | typeof CREATE_CODEX_SESSION_COMMAND_ID;
export type CommandCategory = 'Workspace' | 'Layout' | 'Terminal';
export type CommandShortcutPlatform = 'macos' | 'other';
export type CommandShortcutScope = 'always' | 'standalone';

/** Serializable default-Keybinding metadata consumed by keyboard dispatch and UI. */
export interface CommandShortcut {
  chord: string;
  label: string;
  platform: CommandShortcutPlatform;
  scope: CommandShortcutScope;
}

export interface CommandMetadata {
  id: CommandId;
  title: string;
  category: CommandCategory;
  configurable: boolean;
  defaultShortcuts: readonly CommandShortcut[];
}

export interface CommandState extends CommandMetadata {
  available: boolean;
}

export interface CommandDefinition extends CommandMetadata {
  isAvailable: () => boolean;
  execute: () => void;
}

export interface CommandInvocation {
  commandId: CommandId;
}

export interface DirectionalSplitCommandMetadata extends CommandMetadata {
  direction: DirectionalSplit;
}

/**
 * The stable create-tab presentation and default Keybindings. Cmd+T remains
 * limited to the installed PWA because browsers reserve it; Cmd+Ctrl+T is the
 * browser-safe macOS fallback retained from the existing interaction model.
 */
export const CREATE_TAB_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_TAB_COMMAND_ID,
  title: 'Create tab',
  category: 'Layout',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'ctrl+meta+t', label: 'Cmd+Ctrl+T', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'meta+t', label: 'Cmd+T', platform: 'macos', scope: 'standalone' }),
    Object.freeze({ chord: 'ctrl+t', label: 'Ctrl+T', platform: 'other', scope: 'standalone' }),
  ]),
});

/** Workspace creation shortcuts use browser-safe chords in both tab and PWA modes. */
export const CREATE_WORKSPACE_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_WORKSPACE_COMMAND_ID,
  title: 'New workspace',
  category: 'Workspace',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'ctrl+alt+n', label: 'Ctrl+Alt+N', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+alt+n', label: 'Ctrl+Alt+N', platform: 'other', scope: 'always' }),
  ]),
});

export const CREATE_CODEX_SESSION_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_CODEX_SESSION_COMMAND_ID,
  title: 'New Codex session',
  category: 'Workspace',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'ctrl+alt+c', label: 'Ctrl+Alt+C', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+alt+c', label: 'Ctrl+Alt+C', platform: 'other', scope: 'always' }),
  ]),
});

const SPLIT_RIGHT_DEFAULT_SHORTCUTS: readonly CommandShortcut[] = Object.freeze([
  Object.freeze({ chord: 'ctrl+shift+\\', label: 'Ctrl+Shift+\\', platform: 'macos', scope: 'always' }),
  Object.freeze({ chord: 'ctrl+shift+\\', label: 'Ctrl+Shift+\\', platform: 'other', scope: 'always' }),
]);

/** Stable presentation and browser-local Keybinding metadata for each Split. */
export const DIRECTIONAL_SPLIT_COMMANDS: readonly DirectionalSplitCommandMetadata[] = Object.freeze([
  Object.freeze({
    id: SPLIT_LEFT_COMMAND_ID,
    title: 'Split left',
    category: 'Layout',
    configurable: true,
    direction: 'left',
    defaultShortcuts: Object.freeze([]),
  }),
  Object.freeze({
    id: SPLIT_RIGHT_COMMAND_ID,
    title: 'Split right',
    category: 'Layout',
    configurable: true,
    direction: 'right',
    defaultShortcuts: SPLIT_RIGHT_DEFAULT_SHORTCUTS,
  }),
  Object.freeze({
    id: SPLIT_UP_COMMAND_ID,
    title: 'Split up',
    category: 'Layout',
    configurable: true,
    direction: 'up',
    defaultShortcuts: Object.freeze([]),
  }),
  Object.freeze({
    id: SPLIT_DOWN_COMMAND_ID,
    title: 'Split down',
    category: 'Layout',
    configurable: true,
    direction: 'down',
    defaultShortcuts: Object.freeze([]),
  }),
]);

/** Browser-local macOS Terminal-style presentation clear. */
export const CLEAR_TO_START_COMMAND: CommandMetadata = Object.freeze({
  id: CLEAR_TO_START_COMMAND_ID,
  title: 'Clear to start',
  category: 'Terminal',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'meta+k', label: 'Cmd+K', platform: 'macos', scope: 'always' }),
  ]),
});

/**
 * Authoritative catalogue and guarded invocation seam for user Commands.
 * Availability is evaluated on every read/invocation so callers never retain
 * stale Workspace or Active Pane state.
 */
export class CommandRegistry {
  readonly #definitions = new Map<CommandId, CommandDefinition>();

  constructor(definitions: readonly CommandDefinition[]) {
    for (const definition of definitions) {
      if (this.#definitions.has(definition.id)) {
        throw new Error(`Duplicate Command id: ${definition.id}`);
      }
      this.#definitions.set(definition.id, definition);
    }
  }

  list(): readonly CommandState[] {
    return [...this.#definitions.keys()].map((id) => this.get(id)!);
  }

  get(id: CommandId): CommandState | undefined {
    const definition = this.#definitions.get(id);
    if (!definition) return undefined;
    return {
      id: definition.id,
      title: definition.title,
      category: definition.category,
      configurable: definition.configurable,
      defaultShortcuts: definition.defaultShortcuts,
      available: definition.isAvailable(),
    };
  }

  /** Returns true only when a known, currently-available Command executed. */
  invoke(id: CommandId): boolean {
    const definition = this.#definitions.get(id);
    if (!definition || !definition.isAvailable()) return false;
    definition.execute();
    return true;
  }
}
