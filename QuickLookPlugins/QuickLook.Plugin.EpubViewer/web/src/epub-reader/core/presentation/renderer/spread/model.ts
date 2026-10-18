import type { RendererKind, RenditionPlan } from '../../rendition';
import type { RendererLayoutSnapshot } from '../model';

export type SpreadSlotName = 'left' | 'right';

export interface SpreadSlotAssignment {
  readonly leftSpineIndex: number | null;
  readonly rightSpineIndex: number | null;
  readonly activeSlot: SpreadSlotName;
  readonly trueSpread: boolean;
}

export interface SpreadRendererPolicy {
  /** Gutter for ordinary synthetic spreads. True/FXL spreads override to zero. */
  readonly pageGap: number;
}

export const DEFAULT_SPREAD_RENDERER_POLICY: SpreadRendererPolicy =
  Object.freeze({
    pageGap: 24,
  });

export interface SpreadChildSnapshot {
  readonly spineIndex: number;
  readonly renderer: RendererKind;
  readonly layout: RendererLayoutSnapshot;
}

export interface SpreadLayoutSnapshot extends RendererLayoutSnapshot {
  readonly spread: true;
  readonly gap: number;
  readonly left: SpreadChildSnapshot | null;
  readonly right: SpreadChildSnapshot | null;
  readonly activeSlot: SpreadSlotName;
}

export interface SpreadChildEntry {
  readonly plan: RenditionPlan;
}
