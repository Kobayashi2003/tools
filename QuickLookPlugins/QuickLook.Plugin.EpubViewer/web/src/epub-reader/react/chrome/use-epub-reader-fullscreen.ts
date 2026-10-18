import { useCallback, useEffect, useMemo, useState } from 'react';

export interface EpubReaderFullscreenTarget {
  readonly current: HTMLElement | null;
}

export interface EpubReaderFullscreenController {
  readonly active: boolean;
  readonly supported: boolean;
  readonly enter: () => Promise<boolean>;
  readonly exit: () => Promise<boolean>;
  readonly toggle: () => Promise<boolean>;
}

export interface UseEpubReaderFullscreenOptions {
  readonly onError?: (error: unknown) => void;
}

export function useEpubReaderFullscreen(
  targetRef: EpubReaderFullscreenTarget,
  options: UseEpubReaderFullscreenOptions = {},
): EpubReaderFullscreenController {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);
  const onError = options.onError;

  useEffect(() => {
    const target = targetRef.current;
    const owner = target?.ownerDocument;
    if (!target || !owner) return;
    const update = () => {
      setActive(owner.fullscreenElement === target);
      setSupported(
        owner.fullscreenEnabled !== false &&
          typeof target.requestFullscreen === 'function' &&
          typeof owner.exitFullscreen === 'function',
      );
    };
    owner.addEventListener('fullscreenchange', update);
    const frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      owner.removeEventListener('fullscreenchange', update);
    };
  }, [targetRef]);

  const enter = useCallback(async () => {
    const target = targetRef.current;
    if (!target || typeof target.requestFullscreen !== 'function') return false;
    try {
      await target.requestFullscreen();
      const entered = target.ownerDocument.fullscreenElement === target;
      setActive(entered);
      return entered;
    } catch (error) {
      setActive(false);
      onError?.(error);
      return false;
    }
  }, [onError, targetRef]);

  const exit = useCallback(async () => {
    const owner = targetRef.current?.ownerDocument;
    if (!owner?.fullscreenElement || typeof owner.exitFullscreen !== 'function')
      return false;
    try {
      await owner.exitFullscreen();
      setActive(false);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }, [onError, targetRef]);

  const toggle = useCallback(
    async () =>
      targetRef.current?.ownerDocument.fullscreenElement === targetRef.current
        ? exit()
        : enter(),
    [enter, exit, targetRef],
  );

  return useMemo(
    () => ({ active, supported, enter, exit, toggle }),
    [active, enter, exit, supported, toggle],
  );
}
