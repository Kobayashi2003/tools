import {
  splitResolvedHref,
  type Locator,
  type Publication,
  type PublicationHref,
} from '../../epub/publication';
import { parseEpubCfi, resolveCfiSpineItem } from '../locator';

export function locatorFromHref(
  publication: Publication,
  href: PublicationHref,
): Locator {
  const split = splitResolvedHref(href);
  const item = publication.spine.find(
    (candidate) =>
      splitResolvedHref(candidate.href).resource === split.resource,
  );
  if (!item)
    throw new RangeError(`Publication href is not in the spine: ${href}`);
  return {
    href: item.href,
    spineIndex: item.index,
    locations: {
      ...(split.fragment ? { fragment: split.fragment } : {}),
      progression: 0,
    },
  };
}

export function locatorFromCfi(publication: Publication, cfi: string): Locator {
  const parsed = parseEpubCfi(cfi);
  const item = resolveCfiSpineItem(publication, parsed.packagePath);
  return {
    href: item.href,
    spineIndex: item.index,
    locations: { cfi, progression: 0 },
  };
}
