import type { ReaderTheme } from '../../epub/publication';
import {
  assertExtensionId,
  DuplicateExtensionIdError,
} from '../../extension/model';
import type { ReaderThemeCatalog, ReaderThemeDefinition } from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

export const BUILTIN_READER_THEMES: readonly ReaderThemeDefinition[] =
  Object.freeze([
    Object.freeze({
      id: 'publisher' as const,
      label: 'Publisher',
      preview: 'linear-gradient(135deg, #f8f6f0, #ded7ca)',
    }),
    Object.freeze({
      id: 'light' as const,
      label: 'Light',
      preview: 'linear-gradient(135deg, #fff, #f1f1f1)',
      foreground: '#1a1a1a',
      background: '#ffffff',
      link: '#1a73e8',
      colorScheme: 'light' as const,
    }),
    Object.freeze({
      id: 'dark' as const,
      label: 'Dark',
      preview: 'linear-gradient(135deg, #181818, #606060)',
      foreground: '#e8e8e8',
      background: '#161616',
      link: '#8ab4f8',
      colorScheme: 'dark' as const,
      forceTextColor: true,
    }),
    Object.freeze({
      id: 'sepia' as const,
      label: 'Sepia',
      preview: 'linear-gradient(135deg, #f4ecd8, #dfcba7)',
      foreground: '#2b2118',
      background: '#f4ecd8',
      link: '#7a4f2a',
      colorScheme: 'light' as const,
    }),
    Object.freeze({
      id: 'paper',
      label: 'Paper',
      preview: 'linear-gradient(135deg, #f7f1e3, #dfd2b6)',
      foreground: '#29251f',
      background: '#f7f1e3',
      link: '#765334',
      colorScheme: 'light' as const,
    }),
    Object.freeze({
      id: 'mist',
      label: 'Mist',
      preview: 'linear-gradient(135deg, #edf2f5, #c6d6df)',
      foreground: '#253038',
      background: '#edf2f5',
      link: '#386b82',
      colorScheme: 'light' as const,
    }),
    Object.freeze({
      id: 'graphite',
      label: 'Graphite',
      preview: 'linear-gradient(135deg, #202329, #58606d)',
      foreground: '#e5e8eb',
      background: '#202329',
      link: '#91b9d0',
      colorScheme: 'dark' as const,
      forceTextColor: true,
    }),
  ]);

export class ReaderThemeRegistry implements ReaderThemeCatalog {
  private readonly themes = new Map<string, ReaderThemeDefinition>();
  private readonly protectedIds = new Set<string>();
  private listValue: readonly ReaderThemeDefinition[] | null = null;

  constructor(
    themes: readonly ReaderThemeDefinition[] = BUILTIN_READER_THEMES,
  ) {
    for (const theme of themes) {
      this.register(theme);
      this.protectedIds.add(theme.id);
    }
  }

  register(theme: ReaderThemeDefinition): () => boolean {
    assertExtensionId(theme.id, 'Reader theme id');
    if (this.themes.has(theme.id))
      throw new DuplicateExtensionIdError(theme.id);
    validateTheme(theme);
    const stored = cloneAndFreezePlainData({
      ...theme,
      label: theme.label?.trim() || theme.id,
      ...(theme.ui ? { ui: { ...theme.ui } } : {}),
    });
    this.themes.set(theme.id, stored);
    this.listValue = null;
    return () => this.unregister(theme.id);
  }

  unregister(id: ReaderTheme): boolean {
    if (this.protectedIds.has(id)) return false;
    const removed = this.themes.delete(id);
    if (removed) this.listValue = null;
    return removed;
  }

  resolve(id: ReaderTheme): ReaderThemeDefinition | null {
    return this.themes.get(id) ?? null;
  }

  list(): readonly ReaderThemeDefinition[] {
    return (this.listValue ??= cloneAndFreezePlainData([
      ...this.themes.values(),
    ]));
  }
}

function validateTheme(theme: ReaderThemeDefinition): void {
  for (const value of [
    theme.foreground,
    theme.background,
    theme.link,
    theme.preview,
    ...Object.values(theme.ui ?? {}),
  ]) {
    if (
      value != null &&
      (!value.trim() ||
        value.length > 256 ||
        /[;{}\r\n\f]/u.test(value) ||
        /url\s*\(/iu.test(value))
    )
      throw new TypeError(
        `Reader theme ${theme.id} contains an unsafe CSS value.`,
      );
  }
}
