import type { Locator, LocatorRange } from '../../epub/publication';

export type ReaderMarkKind = 'bookmark' | 'highlight' | 'annotation';
/** Semantic color names align with the current EPUB Annotations interchange draft. */
export type AnnotationColor =
  'pink' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type AnnotationHighlightStyle =
  'solid' | 'underline' | 'strikethrough' | 'outline';

export interface ReaderMarkBase {
  readonly id: string;
  readonly kind: ReaderMarkKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly label?: string;
  readonly tags?: readonly string[];
}

export interface Bookmark extends ReaderMarkBase {
  readonly kind: 'bookmark';
  readonly locator: Locator;
}

export interface Highlight extends ReaderMarkBase {
  readonly kind: 'highlight';
  readonly range: LocatorRange;
  readonly color: AnnotationColor;
  readonly highlight: AnnotationHighlightStyle;
}

export interface Annotation extends ReaderMarkBase {
  readonly kind: 'annotation';
  readonly range: LocatorRange;
  readonly body: string;
  readonly color: AnnotationColor;
  readonly highlight: AnnotationHighlightStyle;
}

export type ReaderMark = Bookmark | Highlight | Annotation;

export interface ReaderMarkPatch {
  readonly body?: string;
  readonly color?: AnnotationColor;
  readonly highlight?: AnnotationHighlightStyle;
  readonly label?: string;
  readonly tags?: readonly string[];
}

export interface ReaderMarkStoreSnapshot {
  readonly revision: number;
  readonly marks: readonly ReaderMark[];
}

export interface ReaderMarkStore {
  snapshot(): ReaderMarkStoreSnapshot;
  put(mark: ReaderMark): void;
  remove(id: string): boolean;
  /** Removes all matching IDs and publishes at most one store revision. */
  removeMany(ids: readonly string[]): number;
  clear(): void;
  subscribe(listener: (snapshot: ReaderMarkStoreSnapshot) => void): () => void;
}
