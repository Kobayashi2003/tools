import type {
  EffectiveSpineRendition,
  PublicationDiagnostic,
  ReaderPreferences,
  SpineItem,
} from '../../epub/publication';
import type {
  OverflowMode,
  RenditionPlannerPolicy,
  ResolvedValue,
} from './model';

export interface FlowResolution {
  readonly overflow: ResolvedValue<OverflowMode>;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export function resolveOverflow(
  rendition: EffectiveSpineRendition,
  preferences: ReaderPreferences,
  policy: RenditionPlannerPolicy,
  item: SpineItem,
): FlowResolution {
  if (rendition.layout === 'pre-paginated') {
    const diagnostics: PublicationDiagnostic[] = [];

    if (rendition.flow !== 'auto') {
      diagnostics.push({
        code: 'RENDITION_FLOW_IGNORED_FOR_FIXED_LAYOUT',
        severity: 'info',
        phase: 'rendition',
        spineIndex: item.index,
        message: `Ignoring authored rendition:flow=${rendition.flow} because the active spine item is pre-paginated.`,
      });
    }

    if (preferences.flow !== 'auto') {
      diagnostics.push({
        code: 'RENDITION_USER_FLOW_IGNORED_FOR_FIXED_LAYOUT',
        severity: 'info',
        phase: 'rendition',
        spineIndex: item.index,
        message: `Ignoring user flow preference ${preferences.flow} because fixed-layout content remains one page per spine item.`,
      });
    }

    return {
      overflow: { value: 'fixed-page', source: 'layout-requirement' },
      diagnostics,
    };
  }

  if (preferences.flow === 'paginated') {
    return {
      overflow: { value: 'paginated', source: 'user' },
      diagnostics: [],
    };
  }

  if (preferences.flow === 'scrolled') {
    return {
      overflow: { value: policy.defaultUserScrolledFlow, source: 'user' },
      diagnostics: [],
    };
  }

  if (rendition.flow === 'paginated') {
    return {
      overflow: {
        value: 'paginated',
        source: item.rendition.flow != null ? 'spine' : 'publication',
      },
      diagnostics: [],
    };
  }

  if (
    rendition.flow === 'scrolled-doc' ||
    rendition.flow === 'scrolled-continuous'
  ) {
    return {
      overflow: {
        value: rendition.flow,
        source: item.rendition.flow != null ? 'spine' : 'publication',
      },
      diagnostics: [],
    };
  }

  return {
    overflow: {
      value: policy.defaultReflowableFlow,
      source: 'reading-system-default',
    },
    diagnostics: [],
  };
}
