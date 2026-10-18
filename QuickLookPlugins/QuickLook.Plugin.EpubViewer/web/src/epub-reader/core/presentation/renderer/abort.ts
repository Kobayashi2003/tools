export function createAbortError(message = 'Operation aborted.'): Error {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal, message?: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : createAbortError(message ?? 'Operation aborted.');
}

export function linkAbortSignal(
  source: AbortSignal,
  target: AbortController,
): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener('abort', onAbort, { once: true });
  return () => source.removeEventListener('abort', onAbort);
}
