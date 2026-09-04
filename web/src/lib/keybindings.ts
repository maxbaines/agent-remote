import type { ResolvedConfig } from './config';
import type { CommandRegistry } from './command-registry.js';
import { isRecordingKeybinding, keyFromEvent, type BrowserKeybindings } from './browser-keybindings.js';

export type Keys = ResolvedConfig['keys'];

export interface UIActions {
  nextSession?: () => void;
  maximizeRegion?: () => void;
  popOut?: () => void;
  openLauncher?: () => void;
  focusDriver?: () => void;
  closePane?: () => void;
  nextTab?: () => void;
  prevTab?: () => void;
  toggleFileTree?: () => void;
}

/** Normalizes a KeyboardEvent to a canonical chord string: ctrl+alt+shift+meta+key. */
function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  parts.push(keyFromEvent(e));
  return parts.join('+');
}

/** Returns true if the event matches the given chord string. */
export function matchChord(chord: string, e: KeyboardEvent): boolean {
  return chordOf(e) === chord.toLowerCase();
}

/** Builds a keyboard event handler from a Keys config and a set of UIActions. */
export function makeKeyHandler(
  keys: Keys,
  actions: UIActions,
): (e: KeyboardEvent) => void {
  const table: [string, (() => void) | undefined][] = [
    [keys.nextSession, actions.nextSession],
    [keys.maximizeRegion, actions.maximizeRegion],
    [keys.popOut, actions.popOut],
    [keys.openLauncher, actions.openLauncher],
    [keys.focusDriver, actions.focusDriver],
  ];

  return (e: KeyboardEvent) => {
    for (const [chord, action] of table) {
      if (action && matchChord(chord, e)) {
        e.preventDefault();
        action();
        return;
      }
    }
  };
}

/**
 * Installs default Keybindings sourced directly from registered Command
 * metadata. Matching unavailable Commands are left unconsumed and cannot run.
 */
export function installCommandShortcuts(
  registry: CommandRegistry,
  preferences: BrowserKeybindings,
): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (isRecordingKeybinding(e)) return;
    for (const command of registry.list()) {
      for (const shortcut of preferences.bindingsFor(command)) {
        if (!matchChord(shortcut.chord, e)) continue;
        if (registry.invoke(command.id)) e.preventDefault();
        return;
      }
    }
  };

  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
}

/**
 * Installs fixed app-level keyboard shortcuts that override browser defaults.
 * These are not user-configurable — they make just-terminal feel like a native app.
 *
 *   Cmd/Ctrl+W      — close the active pane   (interceptable in all modes)
 *   Alt+Cmd/Ctrl+B  — toggle the desktop file tree
 *
 * Returns a cleanup function.
 */
export function installAppShortcuts(
  actions: Pick<UIActions, 'closePane' | 'nextTab' | 'prevTab' | 'toggleFileTree'>,
): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (isRecordingKeybinding(e)) return;
    if ((e.key === 'b' || e.key === 'B') && e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      actions.toggleFileTree?.();
      return;
    }
    if (e.key === 'w' || e.key === 'W') {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        actions.closePane?.();
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs within the active pane group only.
    // Browsers handle Ctrl+Tab at the browser-process level in tab mode, so
    // preventDefault() has no effect there. Works reliably in PWA standalone
    // mode (no browser tabs to switch). In tab mode the shortcut may still fire
    // the action on focus change into the app, but it won't prevent the browser
    // tab switch. Ctrl+Tab is not passed through terminals because it's
    // intercepted in capture phase before the terminal keydown handler fires.
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        actions.prevTab?.();
      } else {
        actions.nextTab?.();
      }
    }
  };

  // Capture phase fires before any element handler — highest JS priority.
  window.addEventListener('keydown', handler, { capture: true });
  return () => window.removeEventListener('keydown', handler, { capture: true });
}
