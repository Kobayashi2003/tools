import type { CSSProperties, ReactNode, RefCallback } from 'react';
import type {
  Annotation,
  AnnotationColor,
  AnnotationHighlightStyle,
  BrowserEpubReaderOpenProgress,
  BrowserEpubReaderOptions,
  BrowserEpubReaderSnapshot,
  Highlight,
  Locator,
  LocatorRange,
  NavigationTarget,
  PublicationDiagnostic,
  ReaderMark,
  ReaderMarkController,
  ReaderMarkPatch,
  ReaderNavigationResult,
  ReaderPreferences,
  ReaderPreferencesPatch,
  ReaderSelection,
  ReaderThemeDefinition,
  SearchHit,
  SearchOptions,
} from '../../core';
import type { ReadingSessionOptions } from './reading-session';

export type EpubSource = Uint8Array | ArrayBuffer | Blob;

export type ReactEpubReaderStatus =
  'idle' | 'loading' | 'ready' | 'error' | 'disposed';

export interface ReactEpubReaderSnapshot {
  readonly status: ReactEpubReaderStatus;
  readonly reader: BrowserEpubReaderSnapshot | null;
  /** Last active or attempted preferences, retained so a failed compatibility experiment can be undone. */
  readonly preferences?: ReaderPreferences;
  readonly diagnostics: readonly PublicationDiagnostic[];
  readonly error: unknown | null;
  readonly openProgress?: BrowserEpubReaderOpenProgress;
}

export interface UseEpubReaderOptions extends BrowserEpubReaderOptions {
  /** Called after the core reader is fully opened and its first locator committed. */
  readonly onReady?: (snapshot: BrowserEpubReaderSnapshot) => void;
  readonly onError?: (error: unknown) => void;
  /** Persist the last locator and preferences locally; pass false to disable. */
  readonly readingSession?: false | ReadingSessionOptions;
}

export interface EpubReaderHandle {
  readonly state: ReactEpubReaderSnapshot;
  readonly viewportRef: RefCallback<HTMLDivElement>;
  retry(): Promise<void>;
  /** Resolves to null when the command failed; the failure is reported through onError. */
  next(): Promise<ReaderNavigationResult | null>;
  previous(): Promise<ReaderNavigationResult | null>;
  goTo(target: NavigationTarget): Promise<Locator | null>;
  goToLocator(locator: Locator): Promise<Locator | null>;
  history: {
    back(steps?: number): Promise<Locator | null>;
    forward(steps?: number): Promise<Locator | null>;
  };
  setPreferences(patch: ReaderPreferencesPatch): Promise<void>;
  captureLocator(): Promise<Locator | null>;
  registerTheme(theme: ReaderThemeDefinition): Promise<void>;
  captureSelection(): ReaderSelection | null;
  clearSelection(): void;
  clearReadingSession(): void;
  addHighlightFromSelection(
    highlight?: AnnotationHighlightStyle,
    color?: AnnotationColor,
  ): Promise<Highlight | null>;
  search: {
    run(
      query: string,
      options?: Partial<SearchOptions>,
    ): Promise<readonly SearchHit[]>;
    clear(): void;
    clearCache(): void;
    goTo(index: number): Promise<SearchHit | null>;
    next(): Promise<SearchHit | null>;
    previous(): Promise<SearchHit | null>;
  };
  marks: {
    addBookmark(
      label?: string,
    ): ReturnType<ReaderMarkController['addBookmark']>;
    addHighlight(
      range: LocatorRange,
      highlight?: AnnotationHighlightStyle,
      color?: AnnotationColor,
      label?: string,
      tags?: readonly string[],
    ): Highlight;
    addAnnotation(
      range: LocatorRange,
      body: string,
      highlight?: AnnotationHighlightStyle,
      color?: AnnotationColor,
      label?: string,
      tags?: readonly string[],
    ): Annotation;
    remove(id: string): boolean;
    removeMany(ids: readonly string[]): number;
    update(id: string, patch: ReaderMarkPatch): ReaderMark | null;
    clear(): void;
    goTo(id: string): Promise<boolean | null>;
  };
}

export interface EpubViewportProps {
  /** Declared explicitly: the local React type contract has no intrinsic key. */
  readonly key?: string;
  readonly reader?: EpubReaderHandle;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
  /**
   * The reader binds its keyboard, pointer and wheel handling to this element,
   * so it has to be the element that takes focus as well. Give it an id and a
   * tabIndex here rather than wrapping it in a focusable parent: key events
   * bubble upward, so a parent that holds focus never reaches these handlers
   * and the arrow keys do nothing.
   */
  readonly id?: string;
  readonly tabIndex?: number;
  readonly children?: ReactNode;
}
