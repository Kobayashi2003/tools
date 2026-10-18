import type { ReaderSearchState } from '../../../features/search';
import {
  resolvePublicationLayoutProfile,
  resolveSpineRendition,
  type ContentPresentationHints,
  type Locator,
  type Publication,
  type ReaderPreferences,
  type WritingMode,
} from '../../../epub/publication';
import type { RendererHostState } from '../../../presentation/renderer';
import {
  DEFAULT_RENDITION_PLANNER_POLICY,
  type RenditionPlannerPolicy,
  type ViewportMetrics,
} from '../../../presentation/rendition';
import type {
  BrowserEpubReaderOptions,
  ReaderPublicationPresentation,
} from '../model';
import { cloneAndFreezePlainData } from '../../../shared/immutable';
import {
  publicationProgress,
  fixedLayoutPublicationProgress,
} from '../../../interaction/locator/progress';

export function resolveReadingPosition(
  publication: Publication,
  locator: Locator | null,
  renderer: RendererHostState,
  presentation: ReaderPublicationPresentation,
) {
  const index = locator?.spineIndex ?? 0;
  const visible = renderer.layout?.visibleSpineIndices ?? [index];
  const first = Math.min(...visible);
  const last = Math.max(...visible);
  const boundary = renderer.layout?.resourceBoundary;
  const atStart = first === 0 && boundary?.atStart === true;
  const atEnd =
    last === publication.spine.length - 1 && boundary?.atEnd === true;
  const within =
    locator?.locations.progression ?? renderer.layout?.progression ?? 0;
  return {
    atStart,
    atEnd,
    publicationProgression: atEnd
      ? 1
      : presentation.layout === 'fixed-layout'
        ? fixedLayoutPublicationProgress(index, publication.spine.length)
        : publicationProgress(index, publication.spine.length, within),
  };
}

export function mergePlannerPolicy(
  input: BrowserEpubReaderOptions['plannerPolicy'],
): RenditionPlannerPolicy {
  return {
    ...DEFAULT_RENDITION_PLANNER_POLICY,
    ...input,
    syntheticSpreads: {
      ...DEFAULT_RENDITION_PLANNER_POLICY.syntheticSpreads,
      ...input?.syntheticSpreads,
    },
  };
}

export function mergeHints(
  previous: ContentPresentationHints | undefined,
  next: ContentPresentationHints,
): ContentPresentationHints {
  return { ...previous, ...next };
}

/** Keep publication chrome stable while page-level presentation hints refine. */
export function resolvePublicationPresentation(
  publication: Publication,
  hints: ReadonlyMap<number, ContentPresentationHints>,
): ReaderPublicationPresentation {
  const layout = resolvePublicationLayoutProfile(publication);
  return cloneAndFreezePlainData({
    layout,
    writingMode: dominantWritingMode(publication, hints),
    chrome: layout === 'fixed-layout' ? 'immersive' : 'standard',
  });
}

export function sameContentHints(
  left: ContentPresentationHints | undefined,
  right: ContentPresentationHints,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

export function sameViewport(
  left: ViewportMetrics,
  right: ViewportMetrics,
): boolean {
  return left.width === right.width && left.height === right.height;
}

export function samePreferences(
  left: ReaderPreferences,
  right: ReaderPreferences,
): boolean {
  return (
    !renderPreferencesChanged(left, right) &&
    left.touchNavigation === right.touchNavigation &&
    left.pageTurnZonePercent === right.pageTurnZonePercent &&
    sameCompatibilityPreferences(left, right)
  );
}

export function renderPreferencesChanged(
  left: ReaderPreferences,
  right: ReaderPreferences,
): boolean {
  return (
    left.flow !== right.flow ||
    left.spread !== right.spread ||
    left.pageProgression !== right.pageProgression ||
    left.fontSizePercent !== right.fontSizePercent ||
    left.fontFamily !== right.fontFamily ||
    left.lineHeight !== right.lineHeight ||
    left.pageMarginPercent !== right.pageMarginPercent ||
    left.fixedLayoutFit !== right.fixedLayoutFit ||
    left.fixedLayoutGutter !== right.fixedLayoutGutter ||
    left.theme !== right.theme
  );
}

export function spreadChanged(
  left: ReaderPreferences,
  right: ReaderPreferences,
): boolean {
  return left.spread !== right.spread;
}

export function mergeApproximateLocator(
  previous: Locator | null,
  spineIndex: number,
  href: string,
  progression: number,
): Locator {
  if (
    previous?.spineIndex === spineIndex &&
    previous.href === href &&
    Math.abs((previous.locations.progression ?? progression) - progression) <
      0.001
  ) {
    return { ...previous, locations: { ...previous.locations, progression } };
  }

  // A layout report has progression but no DOM anchor. Retaining an old CFI
  // would make the composite locator contradictory and restore the wrong page.
  return { spineIndex, href, locations: { progression } };
}

export function emptyRendererState(): RendererHostState {
  return {
    status: 'idle',
    generation: 0,
    plan: null,
    rendererKind: null,
    layout: null,
    stability: null,
    error: null,
  };
}

export function emptySearchState(): ReaderSearchState {
  return {
    query: '',
    hits: [],
    index: -1,
    searching: false,
    truncated: false,
    diagnostics: [],
    error: null,
  };
}

/** Ignore occasional horizontal front/back matter when choosing writing mode. */
function dominantWritingMode(
  publication: Publication,
  hints: ReadonlyMap<number, ContentPresentationHints>,
): WritingMode {
  const tally = new Map<WritingMode, number>();
  for (const item of publication.spine) {
    if (resolveSpineRendition(publication, item).layout === 'pre-paginated')
      continue;
    const mode = hints.get(item.index)?.writingMode;
    if (mode) tally.set(mode, (tally.get(mode) ?? 0) + 1);
  }

  let dominant: WritingMode = 'horizontal-tb';
  let dominantCount = 0;
  for (const [mode, count] of tally) {
    if (count <= dominantCount) continue;
    dominant = mode;
    dominantCount = count;
  }
  return dominant;
}

function sameCompatibilityPreferences(
  left: ReaderPreferences,
  right: ReaderPreferences,
): boolean {
  return (
    left.compatibility.recoverContainerStructure ===
      right.compatibility.recoverContainerStructure &&
    left.compatibility.selectPreferredRootfile ===
      right.compatibility.selectPreferredRootfile &&
    left.compatibility.recoverMalformedXhtml ===
      right.compatibility.recoverMalformedXhtml &&
    left.compatibility.useLegacyNavigationFallback ===
      right.compatibility.useLegacyNavigationFallback &&
    left.compatibility.normalizeLegacyCss ===
      right.compatibility.normalizeLegacyCss &&
    left.compatibility.fitSingleImagePages ===
      right.compatibility.fitSingleImagePages &&
    left.compatibility.deobfuscateIdpfFonts ===
      right.compatibility.deobfuscateIdpfFonts
  );
}
