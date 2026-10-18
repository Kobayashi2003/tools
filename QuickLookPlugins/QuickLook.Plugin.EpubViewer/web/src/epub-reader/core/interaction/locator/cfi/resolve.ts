import type { Publication, SpineItem } from '../../../epub/publication';
import type { CfiPath, DomPoint } from '../model';
import { createEpubCfi } from './create';
import {
  correctPointFromTextAssertion,
  matchesTextAssertion,
  resolveContentCfiPath,
} from './dom';
import { parseEpubCfi, serializeCfiPath, stripCfiAssertions } from './syntax';

export function resolveEpubCfi(
  publication: Publication,
  document: Document,
  cfi: string,
): {
  readonly spineItem: SpineItem;
  readonly point: DomPoint;
  readonly correctedCfi?: string;
} {
  const parsed = parseEpubCfi(cfi);
  const spineItem = resolveCfiSpineItem(publication, parsed.packagePath);
  let point: DomPoint;

  try {
    point = resolveContentCfiPath(document, parsed.contentPath);
  } catch (error) {
    // Text assertions are correction data and may recover a stale DOM path.
    if (!parsed.contentPath.textAssertion) throw error;
    const correctedPoint = correctPointFromTextAssertion(
      document,
      null,
      parsed.contentPath.textAssertion,
    );
    if (!correctedPoint) throw error;
    point = correctedPoint;
  }

  if (
    parsed.contentPath.textAssertion &&
    !matchesTextAssertion(document, point, parsed.contentPath.textAssertion)
  ) {
    const correctedPoint = correctPointFromTextAssertion(
      document,
      point,
      parsed.contentPath.textAssertion,
    );
    if (!correctedPoint) {
      throw new RangeError(
        'EPUB CFI text assertion does not match and cannot be corrected.',
      );
    }
    point = correctedPoint;
  }

  const corrected = createEpubCfi(
    spineItem,
    document,
    point,
    parsed.contentPath.textAssertion,
  );
  return {
    spineItem,
    point,
    ...(corrected !== cfi ? { correctedCfi: corrected } : {}),
  };
}

export function resolveCfiSpineItem(
  publication: Publication,
  packagePath: CfiPath,
): SpineItem {
  const canonical = serializeCfiPath({ steps: packagePath.steps });
  const exact = publication.spine.find(
    (item) =>
      item.cfiBase &&
      stripCfiAssertions(item.cfiBase.slice(0, -1)) ===
        stripCfiAssertions(canonical),
  );
  if (exact) return exact;

  // Package structure may move while an itemref ID assertion remains stable.
  const assertedId = packagePath.steps.at(-1)?.assertion;
  if (assertedId) {
    const corrected = publication.spine.find(
      (item) => item.itemrefId === assertedId,
    );
    if (corrected) return corrected;
  }
  throw new RangeError(
    'EPUB CFI package path does not resolve to a spine item in this publication.',
  );
}
