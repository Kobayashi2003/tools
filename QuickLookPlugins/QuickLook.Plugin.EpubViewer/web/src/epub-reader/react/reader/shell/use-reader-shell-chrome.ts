import { useEffect, useState } from 'react';
import { shouldLockReaderChrome } from '../../chrome/reader-chrome-model';
import {
  useEpubReaderFullscreen,
  type EpubReaderFullscreenController,
} from '../../chrome/use-epub-reader-fullscreen';
import {
  useReaderChrome,
  type ReaderChromeControls,
} from '../../chrome/use-reader-chrome';

interface ReaderShellChromeOptions {
  readonly shellRef: { readonly current: HTMLElement | null };
  readonly hasPublicationSnapshot: boolean;
  readonly surfaceOpen: boolean;
  readonly onFullscreenError: () => void;
  readonly actionsRef: {
    current: Pick<ReaderChromeControls, 'show' | 'toggle'> | null;
  };
}

export interface ReaderShellChromeController {
  readonly chrome: ReaderChromeControls;
  readonly fullscreen: EpubReaderFullscreenController;
  readonly hidden: boolean;
}

export function useReaderShellChrome(
  options: ReaderShellChromeOptions,
): ReaderShellChromeController {
  const {
    shellRef,
    hasPublicationSnapshot,
    surfaceOpen,
    onFullscreenError,
    actionsRef,
  } = options;
  const [pointerOverChrome, setPointerOverChrome] = useState(false);
  const [focusInChrome, setFocusInChrome] = useState(false);
  const chrome = useReaderChrome(
    shouldLockReaderChrome({
      hasPublicationSnapshot,
      surfaceOpen,
      pointerOverChrome,
      focusInChrome,
    }),
  );
  const fullscreen = useEpubReaderFullscreen(shellRef, {
    onError: onFullscreenError,
  });

  useEffect(() => {
    actionsRef.current = chrome;
    return () => {
      actionsRef.current = null;
    };
  }, [actionsRef, chrome]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const toolbar = shell.querySelector<HTMLElement>(
      '.epub-reader-shell__toolbar',
    );
    const controls = shell.querySelector<HTMLElement>('.epub-reader-controls');
    const updateFocusLock = () => {
      const active = shell.ownerDocument.activeElement;
      setFocusInChrome(
        Boolean(
          active && (toolbar?.contains(active) || controls?.contains(active)),
        ),
      );
    };
    const holdPointerLock = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') setPointerOverChrome(true);
    };
    const releasePointerLock = () => setPointerOverChrome(false);
    let focusFrame: number | null = null;
    const deferFocusUpdate = () => {
      if (focusFrame != null) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        focusFrame = null;
        updateFocusLock();
      });
    };
    toolbar?.addEventListener('pointerenter', holdPointerLock, {
      passive: true,
    });
    toolbar?.addEventListener('pointerleave', releasePointerLock, {
      passive: true,
    });
    controls?.addEventListener('pointerenter', holdPointerLock, {
      passive: true,
    });
    controls?.addEventListener('pointerleave', releasePointerLock, {
      passive: true,
    });
    shell.addEventListener('focusin', updateFocusLock);
    shell.addEventListener('focusout', deferFocusUpdate);
    updateFocusLock();
    return () => {
      toolbar?.removeEventListener('pointerenter', holdPointerLock);
      toolbar?.removeEventListener('pointerleave', releasePointerLock);
      controls?.removeEventListener('pointerenter', holdPointerLock);
      controls?.removeEventListener('pointerleave', releasePointerLock);
      shell.removeEventListener('focusin', updateFocusLock);
      shell.removeEventListener('focusout', deferFocusUpdate);
      if (focusFrame != null) cancelAnimationFrame(focusFrame);
    };
  }, [shellRef]);

  return { chrome, fullscreen, hidden: !chrome.visible };
}
