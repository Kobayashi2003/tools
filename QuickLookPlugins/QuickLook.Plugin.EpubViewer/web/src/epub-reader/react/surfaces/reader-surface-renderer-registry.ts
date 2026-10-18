import {
  READER_SURFACE_RENDERER_KINDS,
  type AnyReaderSurfaceRenderer,
  type ReaderSurfaceRenderer,
  type ReaderSurfaceRendererKind,
  type ReaderSurfaceRendererRegistry,
} from './model';

const KINDS = new Set<ReaderSurfaceRendererKind>(READER_SURFACE_RENDERER_KINDS);

/** Resolves one provider per semantic surface; validated overrides replace defaults by kind. */
export function createReaderSurfaceRendererRegistry(
  defaults: readonly AnyReaderSurfaceRenderer[] = [],
  overrides: readonly AnyReaderSurfaceRenderer[] = [],
): ReaderSurfaceRendererRegistry {
  const byKind = new Map<ReaderSurfaceRendererKind, AnyReaderSurfaceRenderer>();
  for (const renderer of validateRendererSet(defaults, 'default'))
    byKind.set(renderer.kind, renderer);
  for (const renderer of validateRendererSet(overrides, 'configured'))
    byKind.set(renderer.kind, renderer);
  const renderers = Object.freeze(
    READER_SURFACE_RENDERER_KINDS.flatMap((kind) => {
      const renderer = byKind.get(kind);
      return renderer ? [renderer] : [];
    }),
  );
  return Object.freeze({
    renderers,
    resolve: <K extends ReaderSurfaceRendererKind>(kind: K) =>
      byKind.get(kind) as ReaderSurfaceRenderer<K> | undefined,
  });
}

function validateRendererSet(
  candidates: readonly AnyReaderSurfaceRenderer[],
  label: string,
): readonly AnyReaderSurfaceRenderer[] {
  if (!Array.isArray(candidates))
    throw new TypeError(`Reader ${label} Surface Renderers must be an array.`);
  const seen = new Set<ReaderSurfaceRendererKind>();
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError(
        `Reader ${label} Surface Renderer at index ${index} must be an object.`,
      );
    }
    if (!KINDS.has(candidate.kind)) {
      throw new TypeError(
        `Unsupported Reader Surface Renderer kind: ${String(candidate.kind)}.`,
      );
    }
    if (seen.has(candidate.kind)) {
      throw new TypeError(
        `Duplicate Reader ${label} Surface Renderer kind: ${candidate.kind}.`,
      );
    }
    if (typeof candidate.render !== 'function') {
      throw new TypeError(
        `Reader Surface Renderer ${candidate.kind} must provide a render function.`,
      );
    }
    seen.add(candidate.kind);
    return Object.freeze({ ...candidate }) as AnyReaderSurfaceRenderer;
  });
}
