export const CREATE_TAB_COMMAND_ID = 'pane.create-tab' as const;
export const SPLIT_LEFT_COMMAND_ID = 'pane.split-left' as const;
export const SPLIT_RIGHT_COMMAND_ID = 'pane.split-right' as const;
export const SPLIT_UP_COMMAND_ID = 'pane.split-up' as const;
export const SPLIT_DOWN_COMMAND_ID = 'pane.split-down' as const;
export const CLEAR_TO_START_COMMAND_ID = 'terminal.clear-to-start' as const;
export const CREATE_WORKSPACE_COMMAND_ID = 'workspace.create' as const;
export const CREATE_CODEX_SESSION_COMMAND_ID = 'workspace.create-codex-session' as const;
export const OPEN_SETTINGS_COMMAND_ID = 'app.open-settings' as const;
export const OPEN_COMMAND_PALETTE_COMMAND_ID = 'app.open-command-palette' as const;
export const TOGGLE_FILE_EXPLORER_COMMAND_ID = 'workspace.toggle-file-explorer' as const;
export const NEXT_TAB_COMMAND_ID = 'pane.next-tab' as const;
export const PREVIOUS_TAB_COMMAND_ID = 'pane.previous-tab' as const;
export const CLOSE_TAB_COMMAND_ID = 'pane.close-tab' as const;
export const FOCUS_LEFT_COMMAND_ID = 'pane.focus-left' as const;
export const FOCUS_RIGHT_COMMAND_ID = 'pane.focus-right' as const;
export const FOCUS_UP_COMMAND_ID = 'pane.focus-up' as const;
export const FOCUS_DOWN_COMMAND_ID = 'pane.focus-down' as const;
export const TOGGLE_SPLIT_ZOOM_COMMAND_ID = 'pane.toggle-split-zoom' as const;

export type DirectionalSplit = 'left' | 'right' | 'up' | 'down';
export type CommandId =
  | typeof CREATE_TAB_COMMAND_ID
  | typeof SPLIT_LEFT_COMMAND_ID
  | typeof SPLIT_RIGHT_COMMAND_ID
  | typeof SPLIT_UP_COMMAND_ID
  | typeof SPLIT_DOWN_COMMAND_ID
  | typeof CLEAR_TO_START_COMMAND_ID
  | typeof CREATE_WORKSPACE_COMMAND_ID
  | typeof CREATE_CODEX_SESSION_COMMAND_ID
  | typeof OPEN_SETTINGS_COMMAND_ID
  | typeof OPEN_COMMAND_PALETTE_COMMAND_ID
  | typeof TOGGLE_FILE_EXPLORER_COMMAND_ID
  | typeof NEXT_TAB_COMMAND_ID
  | typeof PREVIOUS_TAB_COMMAND_ID
  | typeof CLOSE_TAB_COMMAND_ID
  | typeof FOCUS_LEFT_COMMAND_ID
  | typeof FOCUS_RIGHT_COMMAND_ID
  | typeof FOCUS_UP_COMMAND_ID
  | typeof FOCUS_DOWN_COMMAND_ID
  | typeof TOGGLE_SPLIT_ZOOM_COMMAND_ID;
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

/** cmux `newSurface`: create a tab in the active pane group. */
export const CREATE_TAB_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_TAB_COMMAND_ID,
  title: 'Create tab',
  category: 'Layout',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'meta+t', label: 'Cmd+T', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+t', label: 'Ctrl+T', platform: 'other', scope: 'always' }),
  ]),
});

/** cmux `newTab`: create a workspace. */
export const CREATE_WORKSPACE_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_WORKSPACE_COMMAND_ID,
  title: 'New workspace',
  category: 'Workspace',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'meta+n', label: 'Cmd+N', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+n', label: 'Ctrl+N', platform: 'other', scope: 'always' }),
  ]),
});

export const CREATE_CODEX_SESSION_COMMAND: CommandMetadata = Object.freeze({
  id: CREATE_CODEX_SESSION_COMMAND_ID,
  title: 'New Codex session',
  category: 'Workspace',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'shift+meta+c', label: 'Cmd+Shift+C', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+shift+c', label: 'Ctrl+Shift+C', platform: 'other', scope: 'always' }),
  ]),
});

const SPLIT_RIGHT_DEFAULT_SHORTCUTS: readonly CommandShortcut[] = Object.freeze([
  Object.freeze({ chord: 'meta+d', label: 'Cmd+D', platform: 'macos', scope: 'always' }),
  Object.freeze({ chord: 'ctrl+d', label: 'Ctrl+D', platform: 'other', scope: 'standalone' }),
]);

const SPLIT_DOWN_DEFAULT_SHORTCUTS: readonly CommandShortcut[] = Object.freeze([
  Object.freeze({ chord: 'shift+meta+d', label: 'Cmd+Shift+D', platform: 'macos', scope: 'always' }),
  Object.freeze({ chord: 'ctrl+shift+d', label: 'Ctrl+Shift+D', platform: 'other', scope: 'always' }),
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
    defaultShortcuts: SPLIT_DOWN_DEFAULT_SHORTCUTS,
  }),
]);

export const CMUX_COMPATIBLE_COMMANDS: readonly CommandMetadata[] = Object.freeze([
  Object.freeze({
    id: OPEN_SETTINGS_COMMAND_ID,
    title: 'Settings',
    category: 'Workspace',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'meta+,', label: 'Cmd+,', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+,', label: 'Ctrl+,', platform: 'other', scope: 'always' }),
    ]),
  }),
  Object.freeze({
    id: OPEN_COMMAND_PALETTE_COMMAND_ID,
    title: 'Command palette',
    category: 'Workspace',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'shift+meta+p', label: 'Cmd+Shift+P', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+shift+p', label: 'Ctrl+Shift+P', platform: 'other', scope: 'always' }),
    ]),
  }),
  Object.freeze({
    id: TOGGLE_FILE_EXPLORER_COMMAND_ID,
    title: 'Toggle file explorer',
    category: 'Workspace',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'alt+meta+b', label: 'Cmd+Opt+B', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+alt+b', label: 'Ctrl+Alt+B', platform: 'other', scope: 'always' }),
    ]),
  }),
  Object.freeze({
    id: NEXT_TAB_COMMAND_ID,
    title: 'Next tab',
    category: 'Layout',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'shift+meta+]', label: 'Cmd+Shift+]', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+shift+]', label: 'Ctrl+Shift+]', platform: 'other', scope: 'always' }),
    ]),
  }),
  Object.freeze({
    id: PREVIOUS_TAB_COMMAND_ID,
    title: 'Previous tab',
    category: 'Layout',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'shift+meta+[', label: 'Cmd+Shift+[', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+shift+[', label: 'Ctrl+Shift+[', platform: 'other', scope: 'always' }),
    ]),
  }),
  Object.freeze({
    id: CLOSE_TAB_COMMAND_ID,
    title: 'Close tab',
    category: 'Layout',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'meta+w', label: 'Cmd+W', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+w', label: 'Ctrl+W', platform: 'other', scope: 'always' }),
    ]),
  }),
  ...([
    [FOCUS_LEFT_COMMAND_ID, 'Focus pane left', 'left'],
    [FOCUS_RIGHT_COMMAND_ID, 'Focus pane right', 'right'],
    [FOCUS_UP_COMMAND_ID, 'Focus pane up', 'up'],
    [FOCUS_DOWN_COMMAND_ID, 'Focus pane down', 'down'],
  ] as const).map(([id, title, key]) => Object.freeze({
    id,
    title,
    category: 'Layout' as const,
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: `alt+meta+${key}`, label: `Cmd+Opt+${key[0]!.toUpperCase()}${key.slice(1)}`, platform: 'macos' as const, scope: 'always' as const }),
      Object.freeze({ chord: `ctrl+alt+${key}`, label: `Ctrl+Alt+${key[0]!.toUpperCase()}${key.slice(1)}`, platform: 'other' as const, scope: 'always' as const }),
    ]),
  })),
  Object.freeze({
    id: TOGGLE_SPLIT_ZOOM_COMMAND_ID,
    title: 'Toggle pane zoom',
    category: 'Layout',
    configurable: true,
    defaultShortcuts: Object.freeze([
      Object.freeze({ chord: 'shift+meta+enter', label: 'Cmd+Shift+Enter', platform: 'macos', scope: 'always' }),
      Object.freeze({ chord: 'ctrl+shift+enter', label: 'Ctrl+Shift+Enter', platform: 'other', scope: 'always' }),
    ]),
  }),
]);

/** Terminal redraw in the shared Cmd/Ctrl+Shift key family. */
export const CLEAR_TO_START_COMMAND: CommandMetadata = Object.freeze({
  id: CLEAR_TO_START_COMMAND_ID,
  title: 'Clear to start',
  category: 'Terminal',
  configurable: true,
  defaultShortcuts: Object.freeze([
    Object.freeze({ chord: 'shift+meta+k', label: 'Cmd+Shift+K', platform: 'macos', scope: 'always' }),
    Object.freeze({ chord: 'ctrl+shift+k', label: 'Ctrl+Shift+K', platform: 'other', scope: 'always' }),
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
