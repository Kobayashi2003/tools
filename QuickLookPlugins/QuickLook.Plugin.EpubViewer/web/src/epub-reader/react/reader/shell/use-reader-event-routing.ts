import type { ReaderChromeControls } from '../../chrome/use-reader-chrome';
import {
  feedbackForReaderEvent,
  type ReaderFeedbackSpec,
} from '../../chrome/feedback-model';
import type {
  ReaderSurface,
  ReaderSurfaces,
} from '../../chrome/reader-surfaces';
import type {
  EpubReaderHandle,
  EpubSource,
  UseEpubReaderOptions,
} from '../../state/model';
import { useEpubReader } from '../../state/use-epub-reader';
import type { ReaderUiMessages } from '../../configuration/model';
import type { ReaderToolRegistry } from '../../tools/model';

interface ReaderEventRoutingOptions {
  readonly source: EpubSource;
  readonly readerOptions?: UseEpubReaderOptions;
  readonly messages: ReaderUiMessages;
  readonly tools: ReaderToolRegistry;
  readonly surfaces: ReaderSurfaces;
  readonly showSurface: (surface: ReaderSurface) => void;
  readonly closeSurface: (
    restoreFocus?: boolean,
    focusTarget?: HTMLElement | SVGElement | null,
  ) => void;
  readonly activeElement: () => HTMLElement | null;
  readonly showFeedback: (feedback: ReaderFeedbackSpec) => void;
  readonly chromeActionsRef: {
    current: Pick<ReaderChromeControls, 'show' | 'toggle'> | null;
  };
}

/** Routes Core callbacks into fixed Shell semantics before notifying the host. */
export function useReaderEventRouting(
  options: ReaderEventRoutingOptions,
): EpubReaderHandle {
  const {
    source,
    readerOptions,
    messages,
    tools,
    surfaces,
    showSurface,
    closeSurface,
    activeElement,
    showFeedback,
    chromeActionsRef,
  } = options;
  return useEpubReader(source, {
    ...readerOptions,
    onError: (error) => {
      showFeedback({ message: messages.actionFailed, tone: 'boundary' });
      readerOptions?.onError?.(error);
    },
    onExternalLink: (target) => {
      if (readerOptions?.onExternalLink) readerOptions.onExternalLink(target);
      else {
        chromeActionsRef.current?.show();
        showSurface({
          kind: 'external-link',
          source,
          target,
          returnFocus: activeElement(),
        });
      }
    },
    onUnresolvedPublicationLink: (href) => {
      showFeedback({
        message: messages.unresolvedPublicationLink,
        tone: 'boundary',
      });
      readerOptions?.onUnresolvedPublicationLink?.(href);
    },
    onCommand: (command) => {
      if (command.type === 'open-search' || command.type === 'open-help') {
        const tool = tools.forCommand(command.type);
        if (tool) {
          chromeActionsRef.current?.show();
          showSurface({
            kind: 'panel',
            panel: tool.id,
            returnFocus: activeElement(),
          });
        }
      } else if (command.type === 'toggle-chrome') {
        if (!surfaces.open) chromeActionsRef.current?.toggle();
      } else if (command.type === 'escape') {
        closeSurface();
      }
      readerOptions?.onCommand?.(command);
    },
    onEvent: (event) => {
      if (event.type === 'footnote-activated') {
        chromeActionsRef.current?.show();
        showSurface({
          kind: 'footnote',
          source,
          footnote: event.footnote,
          returnFocus: event.trigger,
        });
      } else if (event.type === 'selection-changed') {
        if (event.activation) {
          showSurface({
            kind: 'selection',
            source,
            activation: event.activation,
          });
        } else if (surfaces.selection) {
          // A selection cleared while another surface is open must not close it.
          surfaces.close();
        }
      } else if (event.type === 'mark-activated') {
        showSurface({ kind: 'mark', source, activation: event.activation });
      } else if (event.type === 'image-activated') {
        chromeActionsRef.current?.show();
        showSurface({ kind: 'image', source, activation: event.activation });
      } else {
        const feedback = feedbackForReaderEvent(event, messages);
        if (feedback) showFeedback(feedback);
      }
      readerOptions?.onEvent?.(event);
    },
  });
}
