import type { Publication, ReaderPreferences } from '../../epub/publication';
import type {
  RenditionPlannerPolicy,
  ResolvedPageProgression,
  ResolvedValue,
} from './model';

export function resolvePageProgression(
  publication: Publication,
  preferences: ReaderPreferences,
  policy: RenditionPlannerPolicy,
): ResolvedValue<ResolvedPageProgression> {
  if (preferences.pageProgression !== 'auto') {
    return { value: preferences.pageProgression, source: 'user' };
  }

  // Text re-set in another writing mode turns its pages the way that mode reads.
  if (preferences.writingMode !== 'auto') {
    return {
      value: preferences.writingMode === 'vertical-rl' ? 'rtl' : 'ltr',
      source: 'user',
    };
  }

  if (
    publication.pageProgressionDirection === 'ltr' ||
    publication.pageProgressionDirection === 'rtl'
  ) {
    return {
      value: publication.pageProgressionDirection,
      source: 'publication',
    };
  }

  return {
    value: policy.defaultPageProgression,
    source: 'reading-system-default',
  };
}
