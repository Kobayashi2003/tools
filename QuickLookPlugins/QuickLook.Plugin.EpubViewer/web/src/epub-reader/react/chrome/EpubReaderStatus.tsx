import { useOptionalEpubReaderContext } from '../reader/context';
import { useDelayedFlag } from './loading-delay';
import type { EpubReaderHandle } from '../state/model';
import { useReaderUiConfiguration } from '../configuration/context';

export function EpubReaderStatus({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const { messages } = useReaderUiConfiguration();
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubReaderStatus> requires a reader prop or EpubReaderProvider.',
    );
  // Only while there is no publication yet. Rendering the next page reports the
  // same status, and covering the book with an opening panel on every page turn
  // would be worse than showing nothing at all.
  const isBusy = reader.state.reader == null && reader.state.status !== 'error';
  const showLoading = useDelayedFlag(isBusy);

  if (isBusy && showLoading) {
    const progress = reader.state.openProgress;
    const percent = progress
      ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
      : 0;
    return (
      <div className="epub-reader-status" role="status">
        <span className="epub-reader-status__loader" aria-hidden="true">
          <span />
        </span>
        <strong>
          {progress ? messages.openPhase(progress.phase) : messages.loadingEpub}
        </strong>
        <span>{progress ? `${percent}%` : messages.preparing}</span>
        <span
          className="epub-reader-status__track"
          role="progressbar"
          aria-label={messages.openingPublication}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </span>
      </div>
    );
  }
  if (reader.state.status === 'error') {
    const error = reader.state.error;
    const message =
      error instanceof Error ? error.message : messages.epubOpenFailed;
    return (
      <div className="epub-reader-status" role="alert">
        <strong>{messages.unableToOpenEpub}</strong>
        <span>{message}</span>
        <button type="button" onClick={() => void reader.retry()}>
          {messages.tryAgain}
        </button>
      </div>
    );
  }
  return null;
}
