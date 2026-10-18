import { useEffect, useRef, type MouseEvent } from 'react';
import type { ReaderSurface } from '../../../chrome/reader-surface-model';
import { useReaderUiConfiguration } from '../../../configuration/context';
import { EpubExternalLinkDialog } from '../../../overlays/EpubExternalLinkDialog';
import { ReaderSurfaceRendererSlot } from '../../../surfaces/ReaderSurfaceRendererSlot';
import type { ReaderSurfaceRendererContext } from '../../../surfaces/model';
import { useEpubReaderContext } from '../../context';
import type { ReaderFeedbackController } from '../use-reader-feedback';
import type { ReaderSurfaceController } from '../use-reader-surface-controller';
import {
  focusFirst,
  installFocusTrap,
} from '../../../accessibility/focus-trap';

interface ReaderModalHostProps {
  readonly surface: ReaderSurface;
  readonly onClose: ReaderSurfaceController['close'];
  readonly showFeedback: ReaderFeedbackController['show'];
}

/** Keeps modal semantics and safe external actions fixed while selecting their content provider. */
export function ReaderModalHost({
  surface,
  onClose,
  showFeedback,
}: ReaderModalHostProps) {
  if (surface.kind === 'image') {
    return (
      <ImageSurfaceFrame
        surface={surface}
        onClose={onClose}
        showFeedback={showFeedback}
      />
    );
  }
  if (surface.kind === 'external-link') {
    return (
      <ExternalLinkSurfaceFrame
        surface={surface}
        onClose={onClose}
        showFeedback={showFeedback}
      />
    );
  }
  return null;
}

interface ModalFrameProps<K extends 'image' | 'external-link'> {
  readonly surface: Extract<ReaderSurface, { readonly kind: K }>;
  readonly onClose: ReaderSurfaceController['close'];
  readonly showFeedback: ReaderFeedbackController['show'];
}

function ImageSurfaceFrame({
  surface,
  onClose,
  showFeedback,
}: ModalFrameProps<'image'>) {
  const reader = useEpubReaderContext();
  const { messages, surfaceRendererRegistry } = useReaderUiConfiguration();
  const dialogRef = useRef<HTMLElement | null>(null);
  const renderer = surfaceRendererRegistry.resolve('image');
  useModalFocus(dialogRef);
  if (!renderer) return null;
  const context: ReaderSurfaceRendererContext<'image'> = {
    surface,
    reader,
    close: onClose,
    showFeedback: (message, tone) => showFeedback({ message, tone }),
  };
  return (
    <aside
      ref={dialogRef}
      className="epub-reader-image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={
        surface.activation.alt
          ? `Image: ${surface.activation.alt}`
          : 'Publication image'
      }
      tabIndex={-1}
      onClick={() => onClose(true)}
    >
      <ReaderSurfaceRendererSlot
        renderer={renderer}
        context={context}
        resetKey={surface.activation.src}
        fallback={
          <button
            type="button"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              onClose(true);
            }}
          >
            {messages.actionFailed}
          </button>
        }
      />
    </aside>
  );
}

function ExternalLinkSurfaceFrame({
  surface,
  onClose,
  showFeedback,
}: ModalFrameProps<'external-link'>) {
  const reader = useEpubReaderContext();
  const { messages, surfaceRendererRegistry } = useReaderUiConfiguration();
  const renderer = surfaceRendererRegistry.resolve('external-link');
  if (!renderer) return null;
  const context: ReaderSurfaceRendererContext<'external-link'> = {
    surface,
    reader,
    close: onClose,
    showFeedback: (message, tone) => showFeedback({ message, tone }),
  };
  return (
    <EpubExternalLinkDialog
      target={surface.target}
      onClose={onClose}
      body={
        <ReaderSurfaceRendererSlot
          renderer={renderer}
          context={context}
          resetKey={surface.target.href}
          fallback={<p role="alert">{messages.actionFailed}</p>}
        />
      }
    />
  );
}

function useModalFocus(dialogRef: {
  readonly current: HTMLElement | null;
}): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const removeFocusTrap = installFocusTrap(dialog);
    const frame = requestAnimationFrame(() => focusFirst(dialog));
    return () => {
      cancelAnimationFrame(frame);
      removeFocusTrap();
    };
  }, [dialogRef]);
}
