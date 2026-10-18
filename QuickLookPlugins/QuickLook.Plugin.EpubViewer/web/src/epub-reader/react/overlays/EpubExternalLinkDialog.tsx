import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { CloseIcon } from '../chrome/reader-icons';
import { externalLinkDetails } from './external-link-model';
import type { ExternalLinkTarget } from '../../core';
import { installFocusTrap } from '../accessibility/focus-trap';

interface EpubExternalLinkDialogProps {
  readonly target: ExternalLinkTarget;
  readonly onClose: (restoreFocus?: boolean) => void;
  readonly body: ReactNode;
}

export function EpubExternalLinkDialog({
  target,
  onClose,
  body,
}: EpubExternalLinkDialogProps) {
  const details = externalLinkDetails(target);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const instanceId = useId().replaceAll(':', '');
  const titleId = `${instanceId}-external-link-title`;
  const descriptionId = `${instanceId}-external-link-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const removeFocusTrap = installFocusTrap(dialog);
    cancelRef.current?.focus({ preventScroll: true });
    return removeFocusTrap;
  }, []);

  const opensNewTab = details.kind === 'website';

  return (
    <div
      className="epub-reader-external-link-layer"
      onClick={() => onClose(true)}
    >
      <aside
        ref={dialogRef}
        className="epub-reader-external-link"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Leaving the reader</span>
            <strong id={titleId}>{details.title}</strong>
          </div>
          <button
            type="button"
            aria-label="Cancel external link"
            onClick={() => onClose(true)}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="epub-reader-external-link__body">
          <p id={descriptionId}>
            This book wants to open a link outside the reader.
          </p>
          {body}
        </div>
        <footer>
          <button ref={cancelRef} type="button" onClick={() => onClose(true)}>
            Cancel
          </button>
          <a
            href={details.href}
            target={opensNewTab ? '_blank' : undefined}
            rel={opensNewTab ? 'noopener noreferrer external' : 'external'}
            onClick={() => onClose(true)}
          >
            {details.actionLabel}
            <span aria-hidden="true"> ↗</span>
          </a>
        </footer>
      </aside>
    </div>
  );
}

export function EpubExternalLinkBody({
  target,
}: {
  readonly target: ExternalLinkTarget;
}) {
  const details = externalLinkDetails(target);
  return (
    <>
      <code title={details.destination}>{details.destination}</code>
      <p className="epub-reader-external-link__hint">
        {details.kind === 'website'
          ? 'The website will open in a new tab.'
          : 'Your device will choose the app that handles this link.'}
      </p>
    </>
  );
}
