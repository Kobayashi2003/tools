import type {
  Locator,
  Publication,
  PublicationHref,
} from '../../epub/publication';
import { createEpubCfi, resolveEpubCfi } from './cfi';
import { createDomPath, resolveDomPath } from './dom-path';
import type {
  DomPoint,
  LocatorRestoreMethod,
  LocatorRestoreResult,
} from './model';
import { createTextQuote, resolveTextQuote } from './text-quote';

export interface CompositeLocatorResolution extends LocatorRestoreResult {
  readonly point: DomPoint | null;
  readonly progression?: number;
}

export function createCompositeLocator(
  document: Document,
  publication: Publication,
  spineIndex: number,
  href: PublicationHref,
  progression: number,
  point: DomPoint,
  textExtent = 48,
): Locator {
  const item = publication.spine[spineIndex];
  if (!item || item.href !== href)
    throw new RangeError(`Spine item ${spineIndex} does not match ${href}.`);
  const text = createTextQuote(document, point, textExtent);
  const cfiAssertion = text
    ? {
        ...(text.before
          ? { before: collapseWhitespace(text.before).slice(-16) }
          : {}),
        ...(text.highlight
          ? { after: collapseWhitespace(text.highlight).slice(0, 16) }
          : {}),
      }
    : undefined;
  let cfi: string | undefined;
  try {
    cfi = createEpubCfi(item, document, point, cfiAssertion);
  } catch {
    /* resilient channels remain available */
  }
  const fragment = nearestElementId(point.node);
  const dom = createDomPath(document, point);
  return {
    href,
    spineIndex,
    locations: {
      ...(cfi ? { cfi } : {}),
      ...(fragment ? { fragment } : {}),
      progression: Math.max(0, Math.min(1, progression)),
      ...(dom ? { dom } : {}),
    },
    ...(text ? { text } : {}),
  };
}

/**
 * Resolve locator semantics only. The renderer decides how a DOM point maps to
 * physical scrolling/columns so the locator layer stays layout-agnostic.
 */
export function resolveCompositeLocator(
  document: Document,
  publication: Publication,
  expectedSpineIndex: number,
  locator: Locator,
): CompositeLocatorResolution {
  let point: DomPoint | null = null;
  let method: LocatorRestoreMethod = 'resource-start';
  let correctedCfi: string | undefined;

  if (locator.locations.cfi) {
    try {
      const resolved = resolveEpubCfi(
        publication,
        document,
        locator.locations.cfi,
      );
      if (resolved.spineItem.index === expectedSpineIndex) {
        point = resolved.point;
        correctedCfi = resolved.correctedCfi;
        method = 'cfi';
      }
    } catch {
      /* try resilient fallbacks */
    }
  }

  if (!point && locator.text) {
    point = resolveTextQuote(document, locator.text);
    if (point) method = 'text-quote';
  }

  if (!point && locator.locations.dom) {
    point = resolveDomPath(document, locator.locations.dom);
    if (point) method = 'dom-path';
  }

  // A captured fragment names the nearest section, not the original character
  // position. Keep it behind the exact recovery channels. Href-only targets
  // still reach this branch because they carry no text or DOM location.
  if (!point && locator.locations.fragment) {
    const element = document.getElementById(locator.locations.fragment);
    if (element) {
      point = { node: element, offset: 0 };
      method = 'fragment';
    }
  }

  const progression =
    !point && locator.locations.progression != null
      ? Math.max(0, Math.min(1, locator.locations.progression))
      : undefined;
  if (!point && progression != null) method = 'progression';

  const updated = healedLocator(
    document,
    publication,
    expectedSpineIndex,
    locator,
    point,
    method,
    correctedCfi,
  );
  return {
    locator: updated,
    method,
    point,
    ...(progression != null ? { progression } : {}),
    ...(correctedCfi ? { correctedCfi } : {}),
  };
}

function healedLocator(
  document: Document,
  publication: Publication,
  spineIndex: number,
  locator: Locator,
  point: DomPoint | null,
  method: LocatorRestoreMethod,
  correctedCfi: string | undefined,
): Locator {
  if (correctedCfi)
    return {
      ...locator,
      locations: { ...locator.locations, cfi: correctedCfi },
    };
  if (!point || method === 'cfi') return locator;
  try {
    const rebuilt = createCompositeLocator(
      document,
      publication,
      spineIndex,
      locator.href,
      locator.locations.progression ?? 0,
      point,
      locator.text?.highlight?.length ?? 48,
    );
    return locator.locations.position == null
      ? rebuilt
      : {
          ...rebuilt,
          locations: {
            ...rebuilt.locations,
            position: locator.locations.position,
          },
        };
  } catch {
    // Recovery succeeded. Failure to refresh an optional precision channel
    // must not turn successful navigation into an error.
    return locator;
  }
}

export function locatorAtResourceStart(
  publication: Publication,
  spineIndex: number,
): Locator {
  const item = publication.spine[spineIndex];
  if (!item) throw new RangeError(`Spine item ${spineIndex} does not exist.`);
  return { href: item.href, spineIndex, locations: { progression: 0 } };
}

export function locatorAtResourceEnd(
  publication: Publication,
  spineIndex: number,
): Locator {
  const item = publication.spine[spineIndex];
  if (!item) throw new RangeError(`Spine item ${spineIndex} does not exist.`);
  return { href: item.href, spineIndex, locations: { progression: 1 } };
}

function nearestElementId(node: Node): string | undefined {
  let element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (element) {
    if (element.id) return element.id;
    element = element.parentElement;
  }
  return undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ');
}
