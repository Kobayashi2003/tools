import type { Publication, TocItem } from '../../epub/publication';
import type {
  ReaderAccessibilityDescription,
  ReaderAccessibilityInput,
} from './model';

/** Produces semantic text for an aria-live UI without imposing any DOM on the host app. */
export function describeReaderPosition(
  publication: Publication,
  input: ReaderAccessibilityInput,
): ReaderAccessibilityDescription {
  const locator = input.locator;
  const chapter = locator
    ? chapterForLocator(publication.navigation.toc, locator.href)
    : undefined;
  const page =
    input.layout?.currentPage != null && input.layout?.pageCount != null
      ? `Page ${input.layout.currentPage} of ${input.layout.pageCount}`
      : undefined;
  const progression =
    locator?.locations.progression ?? input.layout?.progression;
  const progress =
    progression != null
      ? `${Math.round(Math.max(0, Math.min(1, progression)) * 100)}%`
      : undefined;
  const announcement =
    [chapter, page, progress].filter(Boolean).join(', ') ||
    publication.metadata.title ||
    'EPUB reader';
  return {
    locator,
    ...(chapter ? { chapter } : {}),
    ...(page ? { page } : {}),
    ...(progress ? { progress } : {}),
    announcement,
  };
}

function chapterForLocator(
  items: readonly TocItem[],
  href: string,
): string | undefined {
  let match: string | undefined;
  const visit = (entries: readonly TocItem[]) => {
    for (const item of entries) {
      if (item.href && stripFragment(item.href) === stripFragment(href))
        match = item.label.trim() || match;
      visit(item.children);
    }
  };
  visit(items);
  return match;
}

function stripFragment(href: string): string {
  const index = href.indexOf('#');
  return index >= 0 ? href.slice(0, index) : href;
}
