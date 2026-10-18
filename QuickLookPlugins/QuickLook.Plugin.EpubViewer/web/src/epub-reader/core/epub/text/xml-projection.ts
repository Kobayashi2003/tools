import type { XmlElementNode, XmlNode } from '../xml';
import {
  isSemanticBlockElementName,
  isSemanticExcludedElementName,
} from './policy';

/** Platform-neutral semantic text used by real-world corpus/conformance probes. */
export function semanticXmlText(root: XmlElementNode): string {
  let text = '';
  const separator = () => {
    if (text && !/\s$/u.test(text)) text += '\n';
  };
  const visit = (node: XmlNode): void => {
    if (node.type === 'text') {
      text += collapseSourceWhitespace(node.value);
      return;
    }
    if (isSemanticExcludedElementName(node.localName)) return;
    const block = isSemanticBlockElementName(node.localName);
    if (block) separator();
    for (const child of node.children) visit(child);
    if (block) separator();
  };
  visit(root);
  return text.replace(/\s+$/u, '');
}

/** Return base/readings for ruby elements so corpus tests can assert projection semantics. */
export function collectRubySamples(
  root: XmlElementNode,
  limit = 32,
): readonly { base: string; reading: string }[] {
  const out: { base: string; reading: string }[] = [];
  const visit = (node: XmlElementNode): void => {
    if (out.length >= limit) return;
    if (node.localName.toLowerCase() === 'ruby') {
      let base = '';
      let reading = '';
      for (const child of node.children) {
        if (child.type === 'text') base += child.value;
        else if (child.localName.toLowerCase() === 'rt')
          reading += rawText(child);
        else if (child.localName.toLowerCase() !== 'rp') base += rawText(child);
      }
      base = base.replace(/\s+/gu, '');
      reading = reading.replace(/\s+/gu, '');
      if (base || reading) out.push({ base, reading });
    }
    for (const child of node.children)
      if (child.type === 'element') visit(child);
  };
  visit(root);
  return out;
}

function rawText(node: XmlElementNode): string {
  let out = '';
  const visit = (child: XmlNode): void => {
    if (child.type === 'text') out += child.value;
    else for (const nested of child.children) visit(nested);
  };
  visit(node);
  return out;
}

function collapseSourceWhitespace(source: string): string {
  return source.replace(/\s+/gu, ' ');
}
