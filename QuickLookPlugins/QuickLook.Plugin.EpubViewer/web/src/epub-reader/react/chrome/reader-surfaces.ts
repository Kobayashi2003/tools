import { useCallback, useMemo, useState } from 'react';
import type {
  ReaderFootnote,
  ExternalLinkTarget,
  ReaderImageActivation,
  ReaderMarkActivation,
  ReaderSelectionActivation,
} from '../../core';
import type { EpubSource } from '../state/model';
import type { ReaderToolId } from '../tools/model';
import {
  readerSurfaceForSource,
  type ReaderSurface,
} from './reader-surface-model';

export { surfaceReturnFocus } from './reader-surface-model';
export type { ReaderSurface } from './reader-surface-model';

/**
 * The one surface the reader is showing over its page, if any.
 *
 * These are mutually exclusive by nature — a panel, a footnote, the selection
 * toolbar, a mark popover, the image viewer and an external-link confirmation all want the same attention and
 * the same slice of the screen. Holding them as one value is what makes that
 * exclusivity true, rather than something each opener has to remember: the
 * previous shape kept five independent flags, and every one of the six ways to
 * open a surface cleared a different subset of the other four. Opening search
 * left an open footnote on screen, opening a footnote left the selection
 * toolbar up, and so on.
 */
const NONE: ReaderSurface = { kind: 'none' };

export interface ReaderSurfaces {
  readonly surface: ReaderSurface;
  /** Narrow accessors, so callers read one surface without re-checking `kind`. */
  readonly panel: ReaderToolId | null;
  readonly footnote: ReaderFootnote | null;
  readonly selection: ReaderSelectionActivation | null;
  readonly mark: ReaderMarkActivation | null;
  readonly image: ReaderImageActivation | null;
  readonly externalLink: ExternalLinkTarget | null;
  /** True while any surface is open, whichever it is. */
  readonly open: boolean;
  show(next: ReaderSurface): void;
  close(): void;
  /** Opens `panel`, or closes it when it is already the open surface. */
  togglePanel(panel: ReaderToolId, returnFocus: HTMLElement | null): void;
}

/**
 * @param source the publication currently open; publication-owned surfaces
 * raised from an earlier one are dropped rather than shown against the wrong book.
 */
export function useReaderSurfaces(source: EpubSource): ReaderSurfaces {
  const [surface, setSurface] = useState<ReaderSurface>(NONE);
  const [previousSource, setPreviousSource] = useState(source);
  if (previousSource !== source) {
    setPreviousSource(source);
    setSurface((current) => readerSurfaceForSource(current, source));
  }

  const show = useCallback((next: ReaderSurface) => setSurface(next), []);
  const close = useCallback(() => setSurface(NONE), []);
  const togglePanel = useCallback(
    (panel: ReaderToolId, returnFocus: HTMLElement | null) => {
      setSurface((current) =>
        current.kind === 'panel' && current.panel === panel
          ? NONE
          : { kind: 'panel', panel, returnFocus },
      );
    },
    [],
  );

  const live = readerSurfaceForSource(surface, source);

  // Memoized so callers can depend on this object in their own hooks without
  // invalidating them on every render.
  return useMemo(
    () => ({
      surface: live,
      panel: live.kind === 'panel' ? live.panel : null,
      footnote: live.kind === 'footnote' ? live.footnote : null,
      selection: live.kind === 'selection' ? live.activation : null,
      mark: live.kind === 'mark' ? live.activation : null,
      image: live.kind === 'image' ? live.activation : null,
      externalLink: live.kind === 'external-link' ? live.target : null,
      open: live.kind !== 'none',
      show,
      close,
      togglePanel,
    }),
    [close, live, show, togglePanel],
  );
}
