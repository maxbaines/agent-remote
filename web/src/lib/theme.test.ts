import { describe, it, expect } from 'vitest';
import { THEME, CHROME, applyAppearanceTokens } from './theme';

describe('fixed Agent Remote appearance', () => {
  it('exports the canonical terminal palette', () => {
    expect(THEME.background).toBe('#1a1b26');
    expect(THEME.foreground).toBe('#a9b1d6');
    expect(THEME.blue).toBe('#7aa2f7');
  });

  it('exports the canonical chrome palette', () => {
    expect(CHROME.bar).toBe('#16161e');
    expect(CHROME.body).toBe(THEME.background);
    expect(CHROME.textDim).toBe('#7f89b3');
  });

  it('applies the fixed terminal tokens', () => {
    const root = document.createElement('div');
    applyAppearanceTokens(root);

    expect(root.style.getPropertyValue('--mux-bg')).toBe(THEME.background);
    expect(root.style.getPropertyValue('--mux-accent')).toBe(THEME.blue);
    expect(root.style.getPropertyValue('--mux-bell')).toBe('var(--mux-warn)');
  });

  it('applies the fixed chrome and layout tokens', () => {
    const root = document.createElement('div');
    applyAppearanceTokens(root);

    expect(root.style.getPropertyValue('--chrome-bar')).toBe(CHROME.bar);
    expect(root.style.getPropertyValue('--chrome-text-dim')).toBe('#7f89b3');
    expect(root.style.getPropertyValue('--mux-tab-min-width')).toBe('80px');
    expect(root.style.getPropertyValue('--mux-tab-max-width')).toBe('180px');
  });

  it('clears obsolete overrides and is idempotent', () => {
    const root = document.createElement('div');
    root.style.setProperty('--mux-titlebar-bg', '#ffffff');
    applyAppearanceTokens(root);
    applyAppearanceTokens(root);

    expect(root.style.getPropertyValue('--mux-titlebar-bg')).toBe('');
    expect(root.style.getPropertyValue('--mux-bg')).toBe(THEME.background);
  });
});
