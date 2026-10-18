import type { ReaderEvent } from '../../core';
import type { ReaderUiMessages } from '../configuration/model';

export type ReaderFeedbackTone = 'success' | 'boundary';

export interface ReaderFeedbackSpec {
  readonly message: string;
  readonly tone: ReaderFeedbackTone;
  readonly edge?: 'start' | 'end';
}

export function feedbackForReaderEvent(
  event: ReaderEvent,
  messages?: Pick<
    ReaderUiMessages,
    'bookmarkSaved' | 'beginningOfBook' | 'endOfBook'
  >,
): ReaderFeedbackSpec | null {
  if (event.type === 'bookmark-added')
    return {
      message: messages?.bookmarkSaved ?? 'Bookmark saved',
      tone: 'success',
    };
  if (event.type === 'navigation-boundary') {
    return {
      message:
        event.edge === 'start'
          ? (messages?.beginningOfBook ?? 'Beginning of book')
          : (messages?.endOfBook ?? 'End of book'),
      tone: 'boundary',
      edge: event.edge,
    };
  }
  return null;
}
