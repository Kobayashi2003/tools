import type { EffectiveSpineRendition, Publication, SpineItem } from './model';

/**
 * Resolve publication-level rendition declarations with one spine item's local
 * overrides. This function has no viewport or user-preference knowledge; that
 * belongs to the future Rendition Planner.
 */
export function resolveSpineRendition(
  publication: Publication,
  item: SpineItem,
): EffectiveSpineRendition {
  return {
    layout: item.rendition.layout ?? publication.rendition.layout,
    orientation:
      item.rendition.orientation ?? publication.rendition.orientation,
    spread: item.rendition.spread ?? publication.rendition.spread,
    flow: item.rendition.flow ?? publication.rendition.flow,
    pageSpread: item.rendition.pageSpread,
    alignXCenter: item.rendition.alignXCenter ?? false,
  };
}

export function isFixedLayout(
  publication: Publication,
  item: SpineItem,
): boolean {
  return resolveSpineRendition(publication, item).layout === 'pre-paginated';
}

/**
 * Effective layout of the reading order as a whole.
 *
 * `mixed` is the common light-novel shape: pre-paginated colour plates and
 * illustration pages interleaved with reflowable chapters. It is descriptive
 * only; callers must not normalize it away, but presentation that belongs to
 * the publication rather than to one page must key off this instead of the
 * active spine item, or it changes on every page turn.
 */
export type PublicationLayoutProfile = 'reflowable' | 'fixed-layout' | 'mixed';

export function resolvePublicationLayoutProfile(
  publication: Publication,
): PublicationLayoutProfile {
  let sawReflowable = false;
  let sawFixed = false;

  for (const item of publication.spine) {
    if (resolveSpineRendition(publication, item).layout === 'pre-paginated')
      sawFixed = true;
    else sawReflowable = true;
    if (sawFixed && sawReflowable) return 'mixed';
  }

  return sawFixed ? 'fixed-layout' : 'reflowable';
}

/**
 * A publication is mixed-layout when effective layout changes across its
 * reading order. This is descriptive only; callers must not normalize it away.
 */
export function hasMixedLayout(publication: Publication): boolean {
  return resolvePublicationLayoutProfile(publication) === 'mixed';
}
