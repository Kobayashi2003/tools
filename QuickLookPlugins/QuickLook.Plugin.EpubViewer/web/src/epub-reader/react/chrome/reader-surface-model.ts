import type {
  ReaderFootnote,
  ExternalLinkTarget,
  ReaderImageActivation,
  ReaderMarkActivation,
  ReaderSelectionActivation,
} from '../../core';
import type { EpubSource } from '../state/model';
import type { ReaderToolId } from '../tools/model';

/** The one surface the reader is showing over its page, if any. */
export type ReaderSurface =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'panel';
      readonly panel: ReaderToolId;
      readonly returnFocus: HTMLElement | null;
    }
  | {
      readonly kind: 'footnote';
      /** Guards against a note outliving the publication it was opened from. */
      readonly source: EpubSource;
      readonly footnote: ReaderFootnote;
      readonly returnFocus: HTMLElement | null;
    }
  | {
      readonly kind: 'selection';
      readonly source: EpubSource;
      readonly activation: ReaderSelectionActivation;
    }
  | {
      readonly kind: 'mark';
      readonly source: EpubSource;
      readonly activation: ReaderMarkActivation;
    }
  | {
      readonly kind: 'image';
      readonly source: EpubSource;
      readonly activation: ReaderImageActivation;
    }
  | {
      readonly kind: 'external-link';
      /** Guards against a link confirmation outliving its publication. */
      readonly source: EpubSource;
      readonly target: ExternalLinkTarget;
      readonly returnFocus: HTMLElement | null;
    };

/** Where focus belongs once this surface closes. */
export function surfaceReturnFocus(
  surface: ReaderSurface,
): HTMLElement | SVGElement | null {
  switch (surface.kind) {
    case 'panel':
    case 'footnote':
    case 'external-link':
      return surface.returnFocus;
    case 'selection':
    case 'mark':
      return surface.activation.returnFocus;
    case 'image':
      return surface.activation.trigger;
    default:
      return null;
  }
}

/** Drop publication-owned UI raised by a reader that is no longer current. */
export function readerSurfaceForSource(
  surface: ReaderSurface,
  source: EpubSource,
): ReaderSurface {
  if (surface.kind === 'none' || surface.kind === 'panel') return surface;
  return surface.source === source ? surface : { kind: 'none' };
}
