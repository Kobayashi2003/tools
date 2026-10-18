import { useEffect } from 'react';
import type { ReaderFootnote } from '../../../core';
import type { EpubSource } from '../../state/model';
import type { ReaderToolId } from '../../tools/model';
import { installFocusTrap } from '../../accessibility/focus-trap';

interface ReaderFocusManagementOptions {
  readonly shellRef: { readonly current: HTMLElement | null };
  readonly panelRef: { readonly current: HTMLElement | null };
  readonly footnoteRef: { readonly current: HTMLElement | null };
  readonly viewportId: string;
  readonly source: EpubSource;
  readonly readerStatus: 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
  readonly panel: ReaderToolId | null;
  readonly footnote: ReaderFootnote | null;
  readonly compactLayout: boolean;
  readonly modalOverlayOpen: boolean;
  readonly chromeHidden: boolean;
}

/** Owns Shell focus transfer and inert regions independently of surface content. */
export function useReaderFocusManagement(
  options: ReaderFocusManagementOptions,
): void {
  const {
    shellRef,
    panelRef,
    footnoteRef,
    viewportId,
    source,
    readerStatus,
    panel,
    footnote,
    compactLayout,
    modalOverlayOpen,
    chromeHidden,
  } = options;

  // Hand the reader keyboard focus after a publication opens, but never take it
  // from a control that already owns it.
  useEffect(() => {
    if (readerStatus !== 'ready') return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document.getElementById(viewportId)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [readerStatus, source, viewportId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!panel) return;
      const preferred =
        panel === 'search'
          ? panelRef.current?.querySelector<HTMLInputElement>(
              'input[type="search"]',
            )
          : null;
      (preferred ?? panelRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [panel, panelRef]);

  useEffect(() => {
    if (!footnote) return;
    const frame = requestAnimationFrame(() => {
      footnoteRef.current
        ?.querySelector<HTMLButtonElement>('button')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [footnote, footnoteRef]);

  useEffect(() => {
    if (!compactLayout || (!panel && !footnote)) return;
    const modal = panel ? panelRef.current : footnoteRef.current;
    const shell = shellRef.current;
    if (!modal || !shell) return;
    const isolated = [
      shell.querySelector<HTMLElement>('.epub-reader-shell__viewport'),
    ].filter((element): element is HTMLElement => Boolean(element));
    for (const element of isolated) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const removeFocusTrap = installFocusTrap(modal);
    return () => {
      removeFocusTrap();
      for (const element of isolated) {
        element.inert = false;
        element.removeAttribute('aria-hidden');
      }
    };
  }, [compactLayout, footnote, footnoteRef, panel, panelRef, shellRef]);

  useEffect(() => {
    if (!modalOverlayOpen) return;
    const shell = shellRef.current;
    if (!shell) return;
    const isolated = [
      shell.querySelector<HTMLElement>('.epub-reader-shell__body'),
    ].filter((element): element is HTMLElement => Boolean(element));
    for (const element of isolated) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    return () => {
      for (const element of isolated) {
        element.inert = false;
        element.removeAttribute('aria-hidden');
      }
    };
  }, [modalOverlayOpen, shellRef]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const bars = [
      shell.querySelector<HTMLElement>('.epub-reader-shell__toolbar'),
      shell.querySelector<HTMLElement>('.epub-reader-controls'),
    ].filter((element): element is HTMLElement => Boolean(element));
    const inert =
      chromeHidden ||
      (compactLayout && Boolean(panel || footnote)) ||
      modalOverlayOpen;
    if (
      inert &&
      bars.some((element) => element.contains(document.activeElement))
    ) {
      document.getElementById(viewportId)?.focus({ preventScroll: true });
    }
    for (const element of bars) {
      element.inert = inert;
      if (inert) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    }
    return () => {
      for (const element of bars) {
        element.inert = false;
        element.removeAttribute('aria-hidden');
      }
    };
  }, [
    chromeHidden,
    compactLayout,
    footnote,
    modalOverlayOpen,
    panel,
    shellRef,
    viewportId,
  ]);
}
