import type { ReaderTheme } from '../../epub/publication';

export interface ReaderThemeDefinition {
  readonly id: ReaderTheme;
  readonly label?: string;
  readonly preview?: string;
  readonly foreground?: string;
  readonly background?: string;
  readonly link?: string;
  readonly colorScheme?: 'light' | 'dark' | 'normal';
  /** If false, publisher text colors remain unless they inherit from body. */
  readonly forceTextColor?: boolean;
  /** Optional host-chrome tokens; React applies only this closed palette. */
  readonly ui?: {
    readonly reader?: string;
    readonly surface?: string;
    readonly surfaceRaised?: string;
    readonly surfaceMuted?: string;
    readonly text?: string;
    readonly textMuted?: string;
    readonly line?: string;
    readonly lineStrong?: string;
    readonly accent?: string;
    readonly accentStrong?: string;
    readonly accentSoft?: string;
  };
}

export interface ReaderThemeResolver {
  resolve(id: ReaderTheme): ReaderThemeDefinition | null;
}

export interface ReaderThemeCatalog extends ReaderThemeResolver {
  list(): readonly ReaderThemeDefinition[];
}
