import type { ReaderFeedbackSpec } from './feedback-model';

export function EpubReaderFeedback({
  feedback,
  feedbackId,
}: {
  readonly feedback: ReaderFeedbackSpec;
  readonly feedbackId: number;
}) {
  return (
    <div
      className={`epub-reader-feedback is-sequence-${feedbackId % 2} is-${feedback.tone}${feedback.edge ? ` is-${feedback.edge}` : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <FeedbackIcon tone={feedback.tone} />
      <span>{feedback.message}</span>
    </div>
  );
}

function FeedbackIcon({ tone }: { readonly tone: ReaderFeedbackSpec['tone'] }) {
  const path =
    tone === 'success'
      ? 'm7 12 3.1 3.1L17.5 7.7'
      : 'M8 7v10M12 8.5 16 12l-4 3.5';
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
