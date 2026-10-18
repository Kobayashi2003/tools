/* eslint-disable react-hooks/refs -- EpubReaderHandle exposes a stable callback ref, not a mutable ref value. */
import type { CSSProperties } from 'react';
import { useOptionalEpubReaderContext } from './context';
import type { EpubViewportProps } from '../state/model';

const DEFAULT_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

export function EpubViewport({
  reader: explicit,
  className,
  style,
  ariaLabel,
  ariaDescribedBy,
  id,
  tabIndex,
  children,
}: EpubViewportProps) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubViewport> requires a reader prop or EpubReaderProvider.',
    );
  const snapshot = reader.state.reader;
  const label =
    ariaLabel ?? snapshot?.publication.metadata.title ?? 'EPUB reader';

  return (
    <div
      ref={reader.viewportRef}
      id={id}
      tabIndex={tabIndex}
      className={className}
      style={{ ...DEFAULT_STYLE, ...style }}
      role="region"
      aria-label={label}
      aria-describedby={ariaDescribedBy}
      aria-busy={reader.state.status === 'loading' || undefined}
      data-epub-reader-status={reader.state.status}
    >
      {children}
      <span aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN}>
        {snapshot?.accessibility.announcement ?? ''}
      </span>
    </div>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
