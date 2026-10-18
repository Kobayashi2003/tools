import type { TextDirection, WritingMode } from '../../../epub/publication';
import type { RendererLayoutSnapshot } from '../model';

export type ReflowableRendererKind =
  'reflowable-paginated' | 'reflowable-scroll';
export type PhysicalScrollAxis = 'horizontal' | 'vertical';
export type HorizontalFlowDirection = 'left-to-right' | 'right-to-left';

export interface ReflowableRendererPolicy {
  /** Physical gutter between CSS overflow columns. */
  readonly pageGap: number;
  /** Keep replaced media inside a dynamic page where possible. */
  readonly containReplacedElements: boolean;
  /** Text context retained by the composite locator for quote/CFI assertion recovery. */
  readonly locatorTextLength: number;
}

export const DEFAULT_REFLOWABLE_RENDERER_POLICY: ReflowableRendererPolicy =
  Object.freeze({
    pageGap: 32,
    containReplacedElements: true,
    locatorTextLength: 48,
  });

export interface ReflowablePresentation {
  readonly writingMode: WritingMode;
  readonly textDirection: TextDirection;
  readonly scrollAxis: PhysicalScrollAxis;
  readonly horizontalFlow: HorizontalFlowDirection;
}

export interface ReflowableLayoutSnapshot extends RendererLayoutSnapshot {
  readonly pageCount?: number;
  readonly currentPage?: number;
  readonly progression: number;
  readonly writingMode: WritingMode;
  readonly textDirection: TextDirection;
  readonly scrollAxis: PhysicalScrollAxis;
  readonly pageGap?: number;
  readonly pageWidth?: number;
  readonly visiblePageCount?: 1 | 2;
}
