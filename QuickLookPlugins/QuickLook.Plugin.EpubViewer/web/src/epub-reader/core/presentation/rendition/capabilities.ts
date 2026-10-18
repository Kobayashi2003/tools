import type { EffectiveSpineRendition } from '../../epub/publication';
import type {
  OverflowMode,
  RenditionCapabilities,
  RenditionPlannerPolicy,
  SpreadPlan,
} from './model';

export function buildRenditionCapabilities(
  rendition: EffectiveSpineRendition,
  overflow: OverflowMode,
  spread: SpreadPlan,
  policy: RenditionPlannerPolicy,
): RenditionCapabilities {
  const reflowable = rendition.layout === 'reflowable';
  const scrolling =
    overflow === 'scrolled-doc' || overflow === 'scrolled-continuous';

  return {
    textCustomization: {
      fontSize: reflowable,
      fontFamily: reflowable,
      lineHeight: reflowable,
    },
    navigation: {
      paginated: !scrolling,
      scroll: scrolling,
      syntheticSpread: !scrolling && policy.syntheticSpreads.supported,
    },
    presentation: {
      intrinsicZoom: !reflowable,
      horizontalCentering: rendition.alignXCenter || spread.mode === 'single',
    },
  };
}
