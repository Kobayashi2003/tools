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
