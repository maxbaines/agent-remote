export const CREATE_TAB_COMMAND_ID = 'pane.create-tab' as const;

export type CommandId = typeof CREATE_TAB_COMMAND_ID;
export type CommandCategory = 'Layout';
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
