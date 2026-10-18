import type { SpineItem } from '../../../epub/publication';
import type { CfiTextAssertion, DomPoint } from '../model';
import { createContentCfiPath } from './dom';
import { serializeCfiPath } from './syntax';

export function createEpubCfi(
  spineItem: SpineItem,
  document: Document,
  point: DomPoint,
  textAssertion?: CfiTextAssertion,
): string {
  if (!spineItem.cfiBase) {
    throw new Error(`Spine item ${spineItem.index} has no CFI package base.`);
  }
  const path = createContentCfiPath(document, point);
  const withAssertion =
    textAssertion && path.characterOffset != null
      ? { ...path, textAssertion }
      : path;
  return `epubcfi(${spineItem.cfiBase}${serializeCfiPath(withAssertion)})`;
}
