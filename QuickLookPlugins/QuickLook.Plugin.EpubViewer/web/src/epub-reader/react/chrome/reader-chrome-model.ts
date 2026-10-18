export type ReaderChromeMode = 'auto' | 'pinned';
export type ReaderChromeVisibility = 'shown' | 'hidden';

export interface ReaderChromeState {
  readonly mode: ReaderChromeMode;
  readonly visibility: ReaderChromeVisibility;
}

export type ReaderChromeEvent =
  | { readonly type: 'show' }
  | { readonly type: 'hide' }
  | { readonly type: 'toggle' }
  | { readonly type: 'set-pinned'; readonly pinned: boolean };

export const INITIAL_READER_CHROME_STATE: ReaderChromeState = {
  mode: 'auto',
  visibility: 'shown',
};

export interface ReaderChromeLockContext {
  readonly hasPublicationSnapshot: boolean;
  readonly surfaceOpen: boolean;
  readonly pointerOverChrome: boolean;
  readonly focusInChrome: boolean;
}

/** Conditions that genuinely require the controls to remain available. */
export function shouldLockReaderChrome(
  context: ReaderChromeLockContext,
): boolean {
  return (
    !context.hasPublicationSnapshot ||
    context.surfaceOpen ||
    context.pointerOverChrome ||
    context.focusInChrome
  );
}

export function reduceReaderChrome(
  state: ReaderChromeState,
  event: ReaderChromeEvent,
): ReaderChromeState {
  if (event.type === 'set-pinned') {
    return event.pinned
      ? { mode: 'pinned', visibility: 'shown' }
      : { mode: 'auto', visibility: 'shown' };
  }
  if (state.mode === 'pinned') return state;
  if (event.type === 'show') {
    return state.visibility === 'shown'
      ? state
      : { ...state, visibility: 'shown' };
  }
  if (event.type === 'hide') {
    return state.visibility === 'hidden'
      ? state
      : { ...state, visibility: 'hidden' };
  }
  return {
    ...state,
    visibility: state.visibility === 'shown' ? 'hidden' : 'shown',
  };
}
