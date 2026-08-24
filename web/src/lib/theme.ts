/**
 * Agent Remote's single bundled desktop appearance.
 *
 * This module deliberately has no palette registry, resolver, light-mode branch,
 * or persistence hook. The terminal palette and chrome tokens are the canonical
 * values documented in DESIGN.md.
 */

export const THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#283457',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};

export interface ChromeTokens {
  bar: string;
  body: string;
  border: string;
  textDim: string;
  textBright: string;
  accent: string;
  driverAccent: string;
  hover: string;
  danger: string;
}

export const CHROME: ChromeTokens = {
  bar: '#16161e',
  body: '#1a1b26',
  border: '#292e42',
  // Brighter than Tokyo Night's comment colour so inactive 13px labels retain
  // at least 4.5:1 contrast against the chrome bar.
  textDim: '#7f89b3',
  textBright: '#c0caf5',
  accent: '#7aa2f7',
  driverAccent: '#bb9af7',
  hover: '#1f2335',
  danger: '#f7768e',
};

const APPEARANCE_CSS_VARS: Record<string, string> = {
  '--mux-bg': THEME.background,
  '--mux-fg': THEME.foreground,
  '--mux-accent': THEME.blue,
  '--mux-border': THEME.brightBlack,
  '--mux-selection': THEME.selectionBackground,
  '--mux-warn': THEME.yellow,
  '--mux-error': THEME.red,
  '--mux-ok': THEME.green,
  '--mux-bell': 'var(--mux-warn)',
  '--mux-dock-height': '44px',
  '--mux-dock-item-padding': '0 16px',
  '--mux-dock-font-size': '0.85rem',
  '--mux-dock-active-weight': '600',
  '--mux-tab-min-width': '80px',
  '--mux-tab-max-width': '180px',
  '--chrome-bar': CHROME.bar,
  '--chrome-body': CHROME.body,
  '--chrome-border': CHROME.border,
  '--chrome-text-dim': CHROME.textDim,
  '--chrome-text-bright': CHROME.textBright,
  '--chrome-accent': CHROME.accent,
  '--chrome-driver-accent': CHROME.driverAccent,
  '--chrome-hover': CHROME.hover,
  '--chrome-danger': CHROME.danger,
};

/** Apply the immutable Agent Remote appearance before the first rendered frame. */
export function applyAppearanceTokens(
  root: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(APPEARANCE_CSS_VARS)) {
    root.style.setProperty(name, value);
  }
  // Old builds offered a browser-local title-bar colour. Never restore it into
  // the fixed appearance, and remove an already-applied override on hot reload.
  root.style.removeProperty('--mux-titlebar-bg');
}
