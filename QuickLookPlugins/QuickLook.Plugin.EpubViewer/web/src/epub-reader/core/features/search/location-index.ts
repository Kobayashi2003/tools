import type {
  Locator,
  LocatorRange,
  LocatorTextContext,
} from '../../epub/publication';
import {
  serializeCfiPath,
  type CfiTextAssertion,
} from '../../interaction/locator';
import type { SearchDocument, SearchTextSegment } from './model';

const TEXT_EXTENT = 48;

/** Resolve a match from the lightweight search index without retaining its parsed DOM. */
export function searchDocumentLocatorRange(
  document: SearchDocument,
  startOffset: number,
  endOffset: number,
): LocatorRange {
  return {
    start: locatorAt(document, startOffset, false),
    end: locatorAt(document, endOffset, true),
  };
}

function locatorAt(
  document: SearchDocument,
  requestedOffset: number,
  endBias: boolean,
): Locator {
  const absolute = clamp(Math.floor(requestedOffset), 0, document.text.length);
  const segment = segmentAt(document.segments, absolute, endBias);
  const progression = document.text.length
    ? absolute / document.text.length
    : 0;
  if (!segment) {
    return {
      href: document.href,
      spineIndex: document.spineIndex,
      locations: { progression },
    };
  }

  const normalizedOffset = clamp(
    absolute - segment.start,
    0,
    segment.end - segment.start,
  );
  const sourceOffset =
    segment.sourceBoundaries[normalizedOffset] ??
    segment.sourceBoundaries[segment.sourceBoundaries.length - 1] ??
    0;
  const text = textContext(document.text, absolute);
  const cfi = segment.cfi ? indexedCfi(segment, sourceOffset, text) : undefined;
  return {
    href: document.href,
    spineIndex: document.spineIndex,
    locations: {
      ...(cfi ? { cfi } : {}),
      ...(segment.fragment ? { fragment: segment.fragment } : {}),
      ...(segment.dom ? { dom: { ...segment.dom, offset: sourceOffset } } : {}),
      progression,
    },
    ...(text ? { text } : {}),
  };
}

function segmentAt(
  segments: readonly SearchTextSegment[],
  offset: number,
  endBias: boolean,
): SearchTextSegment | undefined {
  const exact = segments.find(
    (segment) => offset >= segment.start && offset <= segment.end,
  );
  if (exact) return exact;
  if (endBias)
    return (
      [...segments].reverse().find((segment) => segment.end <= offset) ??
      segments.at(-1)
    );
  return segments.find((segment) => segment.start >= offset) ?? segments[0];
}

function indexedCfi(
  segment: SearchTextSegment,
  sourceOffset: number,
  text: LocatorTextContext | undefined,
): string {
  const base = segment.cfi!;
  const assertion: CfiTextAssertion | undefined = text
    ? {
        ...(text.before
          ? { before: collapseWhitespace(text.before).slice(-16) }
          : {}),
        ...(text.highlight
          ? { after: collapseWhitespace(text.highlight).slice(0, 16) }
          : {}),
      }
    : undefined;
  const contentPath = {
    ...base.contentPath,
    characterOffset: (base.contentPath.characterOffset ?? 0) + sourceOffset,
    ...(assertion ? { textAssertion: assertion } : {}),
  };
  return `epubcfi(${serializeCfiPath(base.packagePath)}!${serializeCfiPath(contentPath)})`;
}

function textContext(
  text: string,
  offset: number,
): LocatorTextContext | undefined {
  const highlight = text.slice(offset, offset + TEXT_EXTENT);
  if (!highlight.trim()) return undefined;
  return {
    before: text.slice(Math.max(0, offset - TEXT_EXTENT), offset),
    highlight,
    after: text.slice(
      offset + highlight.length,
      offset + highlight.length + TEXT_EXTENT,
    ),
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
