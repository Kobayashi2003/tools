import type { Locator, PublicationHref } from '../../epub/publication';
import type { RenditionPlan } from '../../presentation/rendition';
import type {
  LayoutTransactionReason,
  ReadingDirection,
  RendererHostState,
  RendererNavigationResult,
  RendererPresentationResult,
} from '../../presentation/renderer';

export type NavigationDirection = 'forward' | 'backward';

export interface NavigationRendererHost {
  readonly state: RendererHostState;
  navigateWithin(
    direction: ReadingDirection,
  ): Promise<RendererNavigationResult>;
  present(
    plan: RenditionPlan,
    reason?: LayoutTransactionReason,
    targetLocator?: Locator,
  ): Promise<RendererPresentationResult>;
  captureLocator(): Promise<Locator | null>;
}

export interface NavigationPlanProvider {
  planForSpine(spineIndex: number): RenditionPlan | Promise<RenditionPlan>;
}

export interface ReaderNavigationPolicy {
  /** Ordinary sequential navigation skips `linear="no"` spine items. */
  readonly skipNonLinear: boolean;
}

export const DEFAULT_READER_NAVIGATION_POLICY: ReaderNavigationPolicy =
  Object.freeze({
    skipNonLinear: true,
  });

export type ReaderNavigationResult =
  | {
      readonly status: 'moved';
      readonly locator: Locator | null;
      readonly spineChanged: boolean;
    }
  | {
      readonly status: 'boundary';
      readonly edge: 'start' | 'end';
    };

export type NavigationTarget =
  | Locator
  | { readonly kind: 'href'; readonly href: PublicationHref }
  | { readonly kind: 'cfi'; readonly cfi: string };
