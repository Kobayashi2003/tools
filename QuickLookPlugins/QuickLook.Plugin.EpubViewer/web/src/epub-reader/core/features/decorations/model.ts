import type { AnnotationColor, AnnotationHighlightStyle } from '../annotations';
import type { LocatorRange } from '../../epub/publication';
import type { RendererContentDocument } from '../../presentation/renderer';

export type DecorationIntent =
  AnnotationHighlightStyle | 'search' | 'search-current';

export interface ReaderDecoration {
  readonly id: string;
  readonly range: LocatorRange;
  readonly intent: DecorationIntent;
  readonly color?: AnnotationColor;
  readonly ariaLabel?: string;
}

export interface ReaderDecorationActivation {
  readonly decoration: ReaderDecoration;
  readonly clientX: number;
  readonly clientY: number;
  readonly context: RendererContentDocument;
}

export interface DecorationTheme {
  readonly semanticColors: Readonly<Record<AnnotationColor, string>>;
  readonly searchFill: string;
  readonly searchCurrentFill: string;
}

export const DEFAULT_DECORATION_THEME: DecorationTheme = Object.freeze({
  semanticColors: Object.freeze({
    pink: 'rgba(244, 143, 177, 0.4)',
    orange: 'rgba(255, 183, 77, 0.42)',
    yellow: 'rgba(255, 213, 79, 0.4)',
    green: 'rgba(129, 199, 132, 0.38)',
    blue: 'rgba(100, 181, 246, 0.36)',
    purple: 'rgba(186, 104, 200, 0.36)',
  }),
  searchFill: 'rgba(129, 212, 250, 0.32)',
  searchCurrentFill: 'rgba(41, 182, 246, 0.52)',
});
