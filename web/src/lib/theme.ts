/**
 * JustTerminal's bundled terminal themes and theme-derived browser chrome.
 *
 * cmux is the default. A resolved theme is applied to both
 * xterm.js and the semantic CSS variables consumed by the surrounding UI.
 */

// ── Chrome design token shapes ───────────────────────────────────────────────

export interface ChromeTokens {
  bar: string;         // title bar / tab strip / status bar background
  body: string;        // surface body — active tab merges into this
  border: string;      // hairline separators
  textDim: string;     // inactive tab / muted labels
  textBright: string;  // active tab / focused text
  accent: string;      // normal active-tab top line + focus accent
  driverAccent: string; // driver region accent
  hover: string;       // flat icon-button hover background
  danger: string;      // close-× hover / destructive action
}

// Dark chrome shared by the dark terminal palettes.
const CHROME_DARK: ChromeTokens = {
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

// Light chrome shared by the light terminal palettes.
const CHROME_LIGHT: ChromeTokens = {
  bar: '#e8e8ed',
  body: '#f2f2f7',
  border: '#c6c6c8',
  // Maintains at least 4.5:1 contrast against both light chrome surfaces.
  textDim: '#636366',
  textBright: '#1c1c1e',
  accent: '#007aff',
  driverAccent: '#5856d6',
  hover: '#d8d8de',
  danger: '#ff3b30',
};

// cmux's native dark chrome, coordinated with Ghostty's Apple System Colors
// theme. Unlike the other bundled dark palettes, this deliberately follows the
// current local cmux appearance instead of inheriting Tokyo Night chrome.
const CHROME_CMUX: ChromeTokens = {
  bar: '#1a1a1a',
  body: '#1e1e1e',
  // cmux uses a quiet structural hairline; #464646 is the terminal's ANSI
  // bright-black and reads too loudly when repeated around every pane.
  border: '#303033',
  textDim: '#98989d',
  textBright: '#ffffff',
  accent: '#0a84ff',
  driverAccent: '#bf5af2',
  hover: '#2c2c2e',
  danger: '#ff453a',
};

/** The set of palette names that are considered light themes. */
const LIGHT_THEME_IDS = new Set([
  'solarized-light',
  'one-light',
  'github-light',
]);

export function isLightTheme(palette: string): boolean {
  return LIGHT_THEME_IDS.has(palette);
}

// Default cmux chrome design tokens — kept as a static reference for any code
// that directly imports CHROME (type-checked constant access).
// At runtime, always use CSS custom properties (var(--chrome-*)) which are
// updated by applyChromeTokens() when the theme changes.
export const CHROME: ChromeTokens = CHROME_CMUX;

export interface Palette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  scrollbarSliderBackground?: string;
  scrollbarSliderHoverBackground?: string;
  scrollbarSliderActiveBackground?: string;
  /**
   * Opacity for rendered terminal glyphs. The terminal background remains
   * fully opaque; this only softens terminal content for palettes that are
   * meant to evoke a translucent native terminal.
   */
  textOpacity?: number;
}

export interface TerminalBackground {
  id: string;
  label: string;
  image: string;
  position: string;
}

/** Bundled, deliberately low-contrast artwork suitable behind terminal text. */
export const TERMINAL_BACKGROUNDS: readonly TerminalBackground[] = [
  {
    id: 'acid-aurora',
    label: 'Acid Aurora',
    image: '/backgrounds/acid-aurora.png',
    position: 'center',
  },
  {
    id: 'chrome-mirage',
    label: 'Chrome Mirage',
    image: '/backgrounds/chrome-mirage.png',
    position: 'center',
  },
  {
    id: 'cosmic-bloom',
    label: 'Cosmic Bloom',
    image: '/backgrounds/cosmic-bloom.png',
    position: 'center',
  },
];

export function resolveTerminalBackground(id: string): TerminalBackground | null {
  return TERMINAL_BACKGROUNDS.find((background) => background.id === id) ?? null;
}

export const THEME: Palette = {
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

/**
 * The exact Ghostty "Apple System Colors" palette used by the local cmux
 * session. A subtle 0.92 text fade evokes the user's native translucent
 * terminal while keeping the browser terminal background fully opaque.
 */
export const CMUX: Palette = {
  background: '#1e1e1e',
  textOpacity: 0.92,
  foreground: '#ffffff',
  cursor: '#98989d',
  cursorAccent: '#ffffff',
  selectionBackground: '#3f638b',
  selectionForeground: '#ffffff',
  black: '#1a1a1a',
  red: '#cc372e',
  green: '#26a439',
  yellow: '#cdac08',
  blue: '#0869cb',
  magenta: '#9647bf',
  cyan: '#479ec2',
  white: '#98989d',
  brightBlack: '#464646',
  brightRed: '#ff453a',
  brightGreen: '#32d74b',
  brightYellow: '#ffd60a',
  brightBlue: '#0a84ff',
  brightMagenta: '#bf5af2',
  brightCyan: '#76d6ff',
  brightWhite: '#ffffff',
  // Native cmux scrollbars are overlay-like and almost disappear at rest.
  scrollbarSliderBackground: '#98989d2e',
  scrollbarSliderHoverBackground: '#98989d66',
  scrollbarSliderActiveBackground: '#98989d8f',
};

export const GRUVBOX: Palette = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
};

export const CATPPUCCIN: Palette = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#313244',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#89dceb',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#89dceb',
  brightWhite: '#a6adc8',
};

export const DRACULA: Palette = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

export const NORD: Palette = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4',
};

// ── Light themes ─────────────────────────────────────────────────────────────

export const SOLARIZED_LIGHT: Palette = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#586e75',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

export const ONE_LIGHT: Palette = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526fff',
  cursorAccent: '#fafafa',
  selectionBackground: '#d0d0d0',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#4f525e',
  brightRed: '#e45649',
  brightGreen: '#50a14f',
  brightYellow: '#c18401',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#a0a1a7',
};

export const GITHUB_LIGHT: Palette = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#d3e8fd',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export const PALETTES: Record<string, Palette> = {
  // Dark themes
  'tokyo-night': THEME,
  cmux: CMUX,
  catppuccin: CATPPUCCIN,
  gruvbox: GRUVBOX,
  dracula: DRACULA,
  nord: NORD,
  // Light themes
  'solarized-light': SOLARIZED_LIGHT,
  'one-light': ONE_LIGHT,
  'github-light': GITHUB_LIGHT,
};

export const DEFAULT_PALETTE_ID = 'cmux';

export function resolvePalette(name: string): Palette {
  return PALETTES[name] ?? PALETTES[DEFAULT_PALETTE_ID];
}

/** Strip JustTerminal metadata and produce the theme object xterm.js accepts. */
export function paletteToXtermTheme(p: Palette): Omit<Palette, 'textOpacity'> {
  const { textOpacity: _textOpacity, ...theme } = p;
  return theme;
}

export function resolveTerminalPalette(
  name: string,
  backgroundId = 'none',
): Omit<Palette, 'textOpacity'> {
  const palette = paletteToXtermTheme(resolvePalette(name));
  if (!resolveTerminalBackground(backgroundId)) return palette;
  return { ...palette, background: `${palette.background}d9` };
}

/** Maps a Palette to canonical --mux-* CSS custom property names. */
export function paletteToCSSVars(p: Palette): Record<string, string> {
  return {
    '--mux-bg': p.background,
    '--mux-fg': p.foreground,
    '--mux-terminal-text-opacity': String(p.textOpacity ?? 1),
    '--mux-accent': p.blue,
    '--mux-border': p.brightBlack,
    '--mux-selection': p.selectionBackground,
    '--mux-warn': p.yellow,
    '--mux-error': p.red,
    '--mux-ok': p.green,
    // Layout and attention tokens are theme-independent.
    '--mux-bell':               'var(--mux-warn)',  // bell indicator dot color
    '--mux-dock-height':        '44px',             // dock bar row height / touch target
    '--mux-dock-item-padding':  '0 16px',           // horizontal padding on each dock slot
    '--mux-dock-font-size':     '0.85rem',          // workspace label font size
    '--mux-dock-active-weight': '600',              // active workspace label font weight
    '--mux-tab-min-width':      '76px',
    '--mux-tab-max-width':      '168px',
  };
}

/** Applies --mux-* CSS variables from a Palette to the given root element. */
export function applyThemeTokens(
  p: Palette,
  root: HTMLElement = document.documentElement,
): void {
  const vars = paletteToCSSVars(p);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
  // Builds before desktop v1 supported a browser-local title-bar override.
  // The current title bar follows the selected theme, so clear any stale
  // inline value left behind during an in-place upgrade.
  root.style.removeProperty('--mux-titlebar-bg');
}

/** Apply the selected terminal artwork independently from the color palette. */
export function applyTerminalBackground(
  backgroundId: string,
  root: HTMLElement = document.documentElement,
): void {
  const background = resolveTerminalBackground(backgroundId);
  root.style.setProperty(
    '--mux-terminal-background-image',
    background ? `url("${background.image}")` : 'none',
  );
  root.style.setProperty('--mux-terminal-background-position', background?.position ?? 'center');
  root.style.setProperty('--mux-terminal-viewport-bg', background ? 'transparent' : 'var(--mux-bg)');
}

/**
 * Apply --chrome-* CSS custom properties to the root element.
 * Call this once at startup with the initial palette name, then again whenever
 * the user changes the theme. All components use var(--chrome-*) so they
 * update automatically without re-rendering.
 */
export function applyChromeTokens(
  paletteName: string,
  root: HTMLElement = document.documentElement,
): void {
  const tokens = paletteName === 'cmux'
    ? CHROME_CMUX
    : isLightTheme(paletteName) ? CHROME_LIGHT : CHROME_DARK;
  root.style.setProperty('--chrome-bar',           tokens.bar);
  root.style.setProperty('--chrome-body',          tokens.body);
  root.style.setProperty('--chrome-border',        tokens.border);
  root.style.setProperty('--chrome-text-dim',      tokens.textDim);
  root.style.setProperty('--chrome-text-bright',   tokens.textBright);
  root.style.setProperty('--chrome-accent',        tokens.accent);
  root.style.setProperty('--chrome-driver-accent', tokens.driverAccent);
  root.style.setProperty('--chrome-hover',         tokens.hover);
  root.style.setProperty('--chrome-danger',        tokens.danger);

  // Keep the browser/PWA frame coordinated with the in-app title bar. This is
  // visible as the status/title bar in installed and mobile browser contexts.
  root.ownerDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', tokens.bar);
}
