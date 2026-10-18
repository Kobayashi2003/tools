import type { BrowserEpubReaderSnapshot } from '../../../core';
import type { EpubSource, ReactEpubReaderSnapshot } from '../model';

export const SERVER_SNAPSHOT: ReactEpubReaderSnapshot = Object.freeze({
  status: 'idle',
  reader: null,
  diagnostics: [],
  error: null,
});

export function combineAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;
  if (typeof AbortSignal.any === 'function')
    return AbortSignal.any([external, internal]);

  const controller = new AbortController();
  const cleanup = () => {
    external.removeEventListener('abort', abortExternal);
    internal.removeEventListener('abort', abortInternal);
  };
  const abort = (signal: AbortSignal) => {
    cleanup();
    controller.abort(signal.reason);
  };
  const abortExternal = () => abort(external);
  const abortInternal = () => abort(internal);
  if (external.aborted) abort(external);
  else if (internal.aborted) abort(internal);
  else {
    external.addEventListener('abort', abortExternal, { once: true });
    internal.addEventListener('abort', abortInternal, { once: true });
  }
  return controller.signal;
}

export async function sourceBytes(
  source: EpubSource,
): Promise<Uint8Array | ArrayBuffer> {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer)
    return source;
  return source.arrayBuffer();
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Publication open aborted.', 'AbortError');
}

export function statusFromReader(
  snapshot: BrowserEpubReaderSnapshot,
): ReactEpubReaderSnapshot['status'] {
  if (snapshot.status === 'disposed') return 'disposed';
  if (snapshot.status === 'error') return 'error';
  if (snapshot.status === 'ready') return 'ready';
  return 'loading';
}
