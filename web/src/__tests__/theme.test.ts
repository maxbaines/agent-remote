import { describe, it, expect } from 'vitest';
import { THEME, CHROME } from '../lib/theme';

describe('Tokyo Night terminal palette', () => {
  it('exports the expected THEME color values', () => {
    expect(THEME.background).toBe('#1a1b26');
    expect(THEME.blue).toBe('#7aa2f7');
    expect(THEME.magenta).toBe('#bb9af7');
    expect(THEME.foreground).toBe('#a9b1d6');
    expect(THEME.red).toBe('#f7768e');
  });
});

describe('default cmux chrome design tokens', () => {
  it('exports CHROME with all token values matching exactly', () => {
    expect(CHROME.bar).toBe('#1a1a1a');
    expect(CHROME.body).toBe('#1e1e1e');
    expect(CHROME.border).toBe('#303033');
    expect(CHROME.textDim).toBe('#98989d');
    expect(CHROME.textBright).toBe('#ffffff');
    expect(CHROME.accent).toBe('#0a84ff');
    expect(CHROME.driverAccent).toBe('#bf5af2');
    expect(CHROME.hover).toBe('#2c2c2e');
    expect(CHROME.danger).toBe('#ff453a');
  });
});
