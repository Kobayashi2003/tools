import type {
  Locator,
  ReaderMark,
  ReaderMarkKind,
  SearchHit,
  TocItem,
} from '../../core';

export type MarkFilter = 'all' | ReaderMarkKind;

export interface ChapterContext {
  readonly label: string;
  readonly path: readonly string[];
  readonly spineIndex: number;
  readonly href?: string;
}

export interface MarkChapterGroup {
  readonly key: string;
  readonly chapter: ChapterContext;
  readonly marks: readonly ReaderMark[];
}

export interface SearchChapterGroup {
  readonly key: string;
  readonly chapter: ChapterContext;
  readonly results: readonly {
    readonly hit: SearchHit;
    readonly index: number;
  }[];
}

export function documentHref(href?: string): string {
  return href?.split('#', 1)[0] ?? '';
}

export function chapterContext(
  toc: readonly TocItem[],
  href: string | undefined,
  spineIndex: number,
): ChapterContext {
  const match = findTocMatch(toc, href);
  const path = match?.path ?? [`Section ${spineIndex + 1}`];
  return {
    label: path[path.length - 1]!,
    path,
    spineIndex,
    href: match?.item.href,
  };
}

export function tocItemForHref(
  toc: readonly TocItem[],
  href?: string,
): TocItem | null {
  return findTocMatch(toc, href)?.item ?? null;
}

export function groupMarksByChapter(
  marks: readonly ReaderMark[],
  toc: readonly TocItem[],
): readonly MarkChapterGroup[] {
  const groups = new Map<
    string,
    { chapter: ChapterContext; marks: ReaderMark[] }
  >();
  for (const mark of marks) {
    const locator = mark.kind === 'bookmark' ? mark.locator : mark.range.start;
    const chapter = chapterContext(
      toc,
      locatorHref(locator),
      locator.spineIndex,
    );
    const key = `${chapter.spineIndex}:${chapter.href ?? documentHref(locator.href)}`;
    const group = groups.get(key) ?? { chapter, marks: [] };
    group.marks.push(mark);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(
      ([, left], [, right]) =>
        left.chapter.spineIndex - right.chapter.spineIndex,
    )
    .map(([key, group]) => ({ key, ...group }));
}

export function groupSearchHitsByChapter(
  hits: readonly SearchHit[],
  toc: readonly TocItem[],
): readonly SearchChapterGroup[] {
  const groups = new Map<
    string,
    { chapter: ChapterContext; results: { hit: SearchHit; index: number }[] }
  >();
  hits.forEach((hit, index) => {
    const locator = hit.range.start;
    const chapter = chapterContext(toc, locatorHref(locator), hit.spineIndex);
    const key = `${chapter.spineIndex}:${chapter.href ?? documentHref(locator.href)}`;
    const group = groups.get(key) ?? { chapter, results: [] };
    group.results.push({ hit, index });
    groups.set(key, group);
  });
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

export function filterMarks(
  marks: readonly ReaderMark[],
  filter: MarkFilter,
): readonly ReaderMark[] {
  return filter === 'all'
    ? marks
    : marks.filter((mark) => mark.kind === filter);
}

export function markLocator(mark: ReaderMark): Locator {
  return mark.kind === 'bookmark' ? mark.locator : mark.range.start;
}

export function markPreview(mark: ReaderMark, maximum = 140): string {
  const locator = markLocator(mark);
  const source =
    mark.kind === 'bookmark'
      ? locator.text?.highlight ||
        `Saved position ${Math.round((locator.locations.progression ?? 0) * 100)}%`
      : mark.label ||
        locator.text?.highlight ||
        (mark.kind === 'annotation' ? mark.body : 'Highlighted passage');
  const normalized = source.replace(/\s+/gu, ' ').trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1).trimEnd()}…`
    : normalized;
}

export function tocItemCount(items: readonly TocItem[]): number {
  return items.reduce(
    (count, item) => count + 1 + tocItemCount(item.children),
    0,
  );
}

export function locatorHref(locator: Locator): string {
  const fragment = locator.locations.fragment;
  return fragment ? `${documentHref(locator.href)}#${fragment}` : locator.href;
}

interface TocMatch {
  readonly item: TocItem;
  readonly path: readonly string[];
}

function findTocMatch(toc: readonly TocItem[], href?: string): TocMatch | null {
  if (!href) return null;
  const targetDocument = documentHref(href);
  let exact: TocMatch | null = null;
  let documentFallback: TocMatch | null = null;

  const visit = (items: readonly TocItem[], parents: readonly string[]) => {
    for (const item of items) {
      const path = [...parents, item.label];
      if (item.href === href && !exact) exact = { item, path };
      if (
        item.href &&
        documentHref(item.href) === targetDocument &&
        !documentFallback
      ) {
        documentFallback = { item, path };
      }
      visit(item.children, path);
    }
  };
  visit(toc, []);
  return exact ?? documentFallback;
}
