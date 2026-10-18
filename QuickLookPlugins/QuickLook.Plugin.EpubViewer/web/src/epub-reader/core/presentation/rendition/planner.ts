import {
  DEFAULT_READER_PREFERENCES,
  normalizeReaderPreferences,
  resolveSpineRendition,
  type PublicationDiagnostic,
  type TextDirection,
  type WritingMode,
} from '../../epub/publication';
import { buildRenditionCapabilities } from './capabilities';
import { resolveOverflow } from './flow';
import type {
  OrientationPlan,
  PlanRenditionInput,
  RenditionPlan,
  RenditionPlannerPolicy,
  RendererKind,
  ResolvedValue,
} from './model';
import { DEFAULT_RENDITION_PLANNER_POLICY } from './model';
import { resolvePageProgression } from './page-progression';
import { getViewportOrientation, resolveSpread } from './spread';

export function planRendition(input: PlanRenditionInput): RenditionPlan {
  assertPlanInput(input);

  const policy = input.policy ?? DEFAULT_RENDITION_PLANNER_POLICY;
  const spineItem = input.publication.spine[input.spineItem.index]!;
  const preferences = normalizeReaderPreferences(
    input.preferences ?? DEFAULT_READER_PREFERENCES,
  );
  const publicationRendition = resolveSpineRendition(
    input.publication,
    spineItem,
  );
  const pageProgression = resolvePageProgression(
    input.publication,
    preferences,
    policy,
  );
  const flow = resolveOverflow(
    publicationRendition,
    preferences,
    policy,
    spineItem,
  );
  const spread = resolveSpread(
    input.publication,
    spineItem,
    publicationRendition,
    flow.overflow.value,
    preferences,
    input.viewport,
    policy,
    input.contentHints,
  );

  const writingMode = resolveWritingMode(input.contentHints?.writingMode);
  const textDirection = resolveTextDirection(input.contentHints?.direction);
  const orientation = resolveOrientation(
    publicationRendition.orientation,
    input.viewport,
  );
  const renderer = selectRenderer(
    publicationRendition.layout,
    flow.overflow.value,
  );

  const diagnostics: PublicationDiagnostic[] = [
    ...flow.diagnostics,
    ...spread.diagnostics,
    ...(input.compatibilityDiagnostics ?? []),
  ];

  return {
    spineIndex: input.spineItem.index,
    href: input.spineItem.href,
    renderer,
    viewport: { ...input.viewport },
    publicationRendition,
    pageProgression,
    overflow: flow.overflow,
    writingMode,
    textDirection,
    orientation,
    spread: spread.spread,
    alignXCenter: publicationRendition.alignXCenter,
    contentPage: input.contentHints?.page,
    intrinsicViewport: input.contentHints?.viewport,
    preferences,
    compatibility: Object.freeze(
      input.compatibility ?? { fitSingleImagePage: false },
    ),
    capabilities: buildRenditionCapabilities(
      publicationRendition,
      flow.overflow.value,
      spread.spread,
      policy,
    ),
    requirements: {
      intrinsicViewport:
        publicationRendition.layout === 'pre-paginated'
          ? 'required'
          : 'not-required',
      contentPresentationInspection:
        input.contentHints == null ? 'recommended' : 'optional',
    },
    diagnostics,
  };
}

function resolveWritingMode(
  value: WritingMode | undefined,
): ResolvedValue<WritingMode> {
  return value
    ? { value, source: 'content' }
    : { value: 'horizontal-tb', source: 'reading-system-default' };
}

function resolveTextDirection(
  value: TextDirection | undefined,
): ResolvedValue<TextDirection> {
  return value
    ? { value, source: 'content' }
    : { value: 'auto', source: 'reading-system-default' };
}

function resolveOrientation(
  requested: OrientationPlan['requested'],
  viewport: PlanRenditionInput['viewport'],
): OrientationPlan {
  const current = getViewportOrientation(viewport);
  if (requested === 'auto') {
    return {
      requested,
      viewport: current,
      matchesRequested: true,
      preference: 'any',
    };
  }

  return {
    requested,
    viewport: current,
    matchesRequested: current === requested,
    preference:
      requested === 'portrait' ? 'prefer-portrait' : 'prefer-landscape',
  };
}

function selectRenderer(
  layout: RenditionPlan['publicationRendition']['layout'],
  overflow: RenditionPlan['overflow']['value'],
): RendererKind {
  if (layout === 'pre-paginated') {
    return 'fixed-layout';
  }

  if (overflow === 'scrolled-doc' || overflow === 'scrolled-continuous') {
    return 'reflowable-scroll';
  }

  return 'reflowable-paginated';
}

function assertPlanInput(input: PlanRenditionInput): void {
  if (!Number.isFinite(input.viewport.width) || input.viewport.width <= 0) {
    throw new RangeError(
      'Rendition viewport width must be a positive finite number.',
    );
  }
  if (!Number.isFinite(input.viewport.height) || input.viewport.height <= 0) {
    throw new RangeError(
      'Rendition viewport height must be a positive finite number.',
    );
  }

  if (input.publication.spine[input.spineItem.index] !== input.spineItem) {
    const actual = input.publication.spine[input.spineItem.index];
    if (
      actual?.href !== input.spineItem.href ||
      actual?.idref !== input.spineItem.idref
    ) {
      throw new RangeError(
        'The supplied spine item does not belong to the publication at its declared index.',
      );
    }
  }

  validatePolicy(input.policy ?? DEFAULT_RENDITION_PLANNER_POLICY);
}

function validatePolicy(policy: RenditionPlannerPolicy): void {
  const { minViewportWidth, minPageWidth } = policy.syntheticSpreads;
  if (!Number.isFinite(minViewportWidth) || minViewportWidth < 0) {
    throw new RangeError(
      'syntheticSpreads.minViewportWidth must be finite and non-negative.',
    );
  }
  if (!Number.isFinite(minPageWidth) || minPageWidth < 0) {
    throw new RangeError(
      'syntheticSpreads.minPageWidth must be finite and non-negative.',
    );
  }
}
