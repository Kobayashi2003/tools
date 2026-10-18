import { useCallback, useEffect, useRef, useState } from 'react';
import {
  surfaceReturnFocus,
  useReaderSurfaces,
  type ReaderSurface,
  type ReaderSurfaces,
} from '../../chrome/reader-surfaces';
import type { EpubSource } from '../../state/model';
import type { ReaderUiMotion } from '../../configuration/model';
import type { ReaderToolId } from '../../tools/model';

export interface ReaderSurfaceController {
  readonly surfaces: ReaderSurfaces;
  readonly closing: boolean;
  readonly panelRef: { current: HTMLElement | null };
  readonly footnoteRef: { current: HTMLElement | null };
  readonly buttonRefs: { current: Map<ReaderToolId, HTMLButtonElement> };
  readonly activeElement: () => HTMLElement | null;
  readonly show: (surface: ReaderSurface) => void;
  readonly close: (
    restoreFocus?: boolean,
    focusTarget?: HTMLElement | SVGElement | null,
  ) => void;
  readonly togglePanel: (
    panel: ReaderToolId,
    origin: HTMLButtonElement,
  ) => void;
}

export function useReaderSurfaceController(
  source: EpubSource,
  viewportId: string,
  motion: ReaderUiMotion,
): ReaderSurfaceController {
  const surfaces = useReaderSurfaces(source);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const footnoteRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef(new Map<ReaderToolId, HTMLButtonElement>());

  /** Focus whatever raised the surface, or the page itself if it is gone. */
  const restoreFocus = useCallback(
    (target: HTMLElement | SVGElement | null) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const fallback = document.getElementById(viewportId);
          const resolve = () => (target?.isConnected ? target : fallback);
          resolve()?.focus({ preventScroll: true });
          // Browsers may drop focus to body when its element disappears in the
          // same commit, so retry once after the next layout frame.
          requestAnimationFrame(() => {
            if (document.activeElement === document.body)
              resolve()?.focus({ preventScroll: true });
          });
        });
      });
    },
    [viewportId],
  );

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setClosing(false);
  }, []);

  const show = useCallback(
    (next: ReaderSurface) => {
      cancelClose();
      surfaces.show(next);
    },
    [cancelClose, surfaces],
  );

  const close = useCallback(
    (withFocus = true, focusTarget?: HTMLElement | SVGElement | null) => {
      if (closeTimerRef.current != null) return;
      const target = focusTarget ?? surfaceReturnFocus(surfaces.surface);
      const finish = () => {
        closeTimerRef.current = null;
        surfaces.close();
        setClosing(false);
        if (withFocus) restoreFocus(target);
      };
      if (
        surfaces.surface.kind !== 'panel' &&
        surfaces.surface.kind !== 'footnote'
      ) {
        finish();
        return;
      }
      setClosing(true);
      const reducedMotion =
        motion === 'reduced' ||
        (typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      closeTimerRef.current = setTimeout(finish, reducedMotion ? 0 : 180);
    },
    [motion, restoreFocus, surfaces],
  );

  const togglePanel = useCallback(
    (next: ReaderToolId, origin: HTMLButtonElement) => {
      if (surfaces.panel === next) close();
      else show({ kind: 'panel', panel: next, returnFocus: origin });
    },
    [close, show, surfaces.panel],
  );

  const activeElement = useCallback(
    () =>
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    [],
  );

  useEffect(
    () => () => {
      if (closeTimerRef.current != null) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return {
    surfaces,
    closing,
    panelRef,
    footnoteRef,
    buttonRefs,
    activeElement,
    show,
    close,
    togglePanel,
  };
}
