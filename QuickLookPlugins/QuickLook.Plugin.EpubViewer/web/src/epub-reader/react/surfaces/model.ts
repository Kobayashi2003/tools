import type { ReactNode } from 'react';
import type { ReaderSurface } from '../chrome/reader-surface-model';
import type { EpubReaderHandle } from '../state/model';

export const READER_SURFACE_RENDERER_KINDS = [
  'footnote',
  'selection',
  'mark',
  'image',
  'external-link',
] as const;

export type ReaderSurfaceRendererKind =
  (typeof READER_SURFACE_RENDERER_KINDS)[number];
export type RenderableReaderSurface = Extract<
  ReaderSurface,
  { readonly kind: ReaderSurfaceRendererKind }
>;
export type ReaderSurfaceFeedbackTone = 'success' | 'boundary';

interface ReaderSurfaceRendererContextBase<
  K extends ReaderSurfaceRendererKind,
> {
  readonly surface: Extract<RenderableReaderSurface, { readonly kind: K }>;
  readonly reader: EpubReaderHandle;
  readonly close: (restoreFocus?: boolean) => void;
  readonly showFeedback: (
    message: string,
    tone: ReaderSurfaceFeedbackTone,
  ) => void;
}

export type ReaderSurfaceRendererContext<K extends ReaderSurfaceRendererKind> =
  ReaderSurfaceRendererContextBase<K> &
    (K extends 'selection'
      ? {
          readonly setMode: (mode: 'toolbar' | 'dialog') => void;
          readonly showSaved: (kind: 'highlight' | 'annotation') => void;
        }
      : object);

/** Supplies content for one Shell-framed semantic surface. */
export interface ReaderSurfaceRenderer<K extends ReaderSurfaceRendererKind> {
  readonly kind: K;
  readonly render: (context: ReaderSurfaceRendererContext<K>) => ReactNode;
}

export type AnyReaderSurfaceRenderer = {
  [K in ReaderSurfaceRendererKind]: ReaderSurfaceRenderer<K>;
}[ReaderSurfaceRendererKind];

export interface ReaderSurfaceRendererRegistry {
  readonly renderers: readonly AnyReaderSurfaceRenderer[];
  resolve<K extends ReaderSurfaceRendererKind>(
    kind: K,
  ): ReaderSurfaceRenderer<K> | undefined;
}
