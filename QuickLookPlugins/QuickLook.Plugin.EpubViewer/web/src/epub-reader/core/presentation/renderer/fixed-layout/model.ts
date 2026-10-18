import type { IntrinsicViewport } from '../../../epub/publication';
import type { RendererLayoutSnapshot } from '../model';

export interface FixedLayoutRendererPolicy {
  readonly fit: 'contain';
  /** Center letterboxed content on both axes. */
  readonly center: boolean;
}

export type FixedLayoutHorizontalAlignment = 'start' | 'center' | 'end';

export const DEFAULT_FIXED_LAYOUT_RENDERER_POLICY: FixedLayoutRendererPolicy =
  Object.freeze({
    fit: 'contain',
    center: true,
  });

export interface FixedLayoutPlacement {
  readonly intrinsic: IntrinsicViewport;
  readonly available: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface FixedLayoutSnapshot extends RendererLayoutSnapshot {
  readonly pageCount: 1;
  readonly currentPage: 1;
  readonly intrinsicViewport: IntrinsicViewport;
  readonly scale: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}
