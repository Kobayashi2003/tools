import type {
  DiagnosticPhase,
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';

export interface XmlTextNode {
  readonly type: 'text';
  readonly value: string;
}

export interface XmlElementNode {
  readonly type: 'element';
  readonly name: string;
  readonly localName: string;
  readonly namespaceUri?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlTextNode | XmlElementNode;

export interface XmlParseResult {
  readonly root: XmlElementNode | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

interface MutableElement {
  type: 'element';
  name: string;
  localName: string;
  namespaceUri?: string;
  namespaces: Record<string, string>;
  attributes: Record<string, string>;
  children: XmlNode[];
}

/**
 * Small non-DOM XML parser for EPUB control documents.
 *
 * It deliberately does not resolve external entities or fetch DTDs. EPUB 2 NCX
 * doctypes are tolerated, but only XML predefined/numeric entities are decoded.
 * Publisher content XHTML is not rendered through this parser; content
 * materialization uses the browser XML/DOM implementation inside the rendering path.
 */
export function parseXml(
  text: string,
  path?: PublicationPath,
  phase: DiagnosticPhase = 'package',
): XmlParseResult {
  const diagnostics: PublicationDiagnostic[] = [];
  const stack: MutableElement[] = [];
  let root: MutableElement | null = null;
  let i = 0;

  const addText = (raw: string) => {
    if (!raw || stack.length === 0) return;
    const value = decodeEntities(raw, diagnostics, path, phase);
    if (value) stack[stack.length - 1]!.children.push({ type: 'text', value });
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(text.slice(i));
      break;
    }

    addText(text.slice(i, lt));
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_COMMENT',
            'error',
            'Unterminated XML comment.',
            path,
            phase,
          ),
        );
        break;
      }
      i = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_CDATA',
            'error',
            'Unterminated CDATA section.',
            path,
            phase,
          ),
        );
        break;
      }
      addText(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }

    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_PI',
            'error',
            'Unterminated XML processing instruction.',
            path,
            phase,
          ),
        );
        break;
      }
      i = end + 2;
      continue;
    }

    if (/^<!DOCTYPE\b/i.test(text.slice(i, i + 16))) {
      const end = findDoctypeEnd(text, i + 9);
      if (end < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_DOCTYPE',
            'error',
            'Unterminated XML doctype.',
            path,
            phase,
          ),
        );
        break;
      }
      diagnostics.push(
        diag(
          'XML_DOCTYPE_IGNORED',
          'info',
          'DOCTYPE declaration was ignored; external entities are never resolved.',
          path,
          phase,
        ),
      );
      i = end + 1;
      continue;
    }

    if (text.startsWith('</', i)) {
      const close = text.indexOf('>', i + 2);
      if (close < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_END_TAG',
            'error',
            'Unterminated XML end tag.',
            path,
            phase,
          ),
        );
        break;
      }
      const name = text.slice(i + 2, close).trim();
      const current = stack.pop();
      if (!current || current.name !== name) {
        diagnostics.push(
          diag(
            'XML_MISMATCHED_END_TAG',
            'error',
            `Unexpected end tag </${name}>${current ? `; expected </${current.name}>` : ''}.`,
            path,
            phase,
          ),
        );
      }
      i = close + 1;
      continue;
    }

    if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close < 0) {
        diagnostics.push(
          diag(
            'XML_UNTERMINATED_DECLARATION',
            'error',
            'Unterminated XML declaration.',
            path,
            phase,
          ),
        );
        break;
      }
      diagnostics.push(
        diag(
          'XML_DECLARATION_IGNORED',
          'warning',
          'Unsupported XML declaration was ignored.',
          path,
          phase,
        ),
      );
      i = close + 1;
      continue;
    }

    const tagEnd = findTagEnd(text, i + 1);
    if (tagEnd < 0) {
      diagnostics.push(
        diag(
          'XML_UNTERMINATED_START_TAG',
          'error',
          'Unterminated XML start tag.',
          path,
          phase,
        ),
      );
      break;
    }

    let inside = text.slice(i + 1, tagEnd);
    const selfClosing = /\/\s*$/.test(inside);
    if (selfClosing) inside = inside.replace(/\/\s*$/, '');

    const parsed = parseStartTag(inside, diagnostics, path, phase);
    if (!parsed) {
      i = tagEnd + 1;
      continue;
    }

    const namespaces = { ...(stack[stack.length - 1]?.namespaces ?? {}) };
    for (const [key, value] of Object.entries(parsed.attributes)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const colon = parsed.name.indexOf(':');
    const prefix = colon < 0 ? '' : parsed.name.slice(0, colon);
    const element: MutableElement = {
      type: 'element',
      name: parsed.name,
      localName: localName(parsed.name),
      namespaceUri: namespaces[prefix],
      namespaces,
      attributes: parsed.attributes,
      children: [],
    };

    if (stack.length > 0)
      stack[stack.length - 1]!.children.push(element as XmlElementNode);
    else if (root === null) root = element;
    else
      diagnostics.push(
        diag(
          'XML_MULTIPLE_ROOTS',
          'error',
          'XML document contains multiple root elements.',
          path,
          phase,
        ),
      );

    if (!selfClosing) stack.push(element);
    i = tagEnd + 1;
  }

  if (stack.length > 0) {
    diagnostics.push(
      diag(
        'XML_UNCLOSED_ELEMENTS',
        'error',
        `XML ended with unclosed element <${stack[stack.length - 1]!.name}>.`,
        path,
        phase,
      ),
    );
  }

  return { root: root as XmlElementNode | null, diagnostics };
}

export function childElements(
  element: XmlElementNode,
  name?: string,
): XmlElementNode[] {
  return element.children.filter(
    (node): node is XmlElementNode =>
      node.type === 'element' &&
      (name === undefined || node.localName === name),
  );
}

export function firstChild(
  element: XmlElementNode,
  name: string,
): XmlElementNode | undefined {
  return childElements(element, name)[0];
}

export function descendants(
  element: XmlElementNode,
  name?: string,
): XmlElementNode[] {
  const out: XmlElementNode[] = [];
  const visit = (node: XmlElementNode) => {
    for (const child of childElements(node)) {
      if (name === undefined || child.localName === name) out.push(child);
      visit(child);
    }
  };
  visit(element);
  return out;
}

export function attr(
  element: XmlElementNode,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    if (element.attributes[name] !== undefined) return element.attributes[name];
  }

  const localCandidates = names.filter((name) => !name.includes(':'));
  for (const [key, value] of Object.entries(element.attributes)) {
    const local = localName(key);
    if (localCandidates.includes(local)) return value;
  }

  return undefined;
}

export function textContent(element: XmlElementNode): string {
  let out = '';
  const visit = (node: XmlNode) => {
    if (node.type === 'text') out += node.value;
    else for (const child of node.children) visit(child);
  };
  visit(element);
  return normalizeWhitespace(out);
}

/** Navigation labels include text alternatives for common embedded elements. */
export function navigationLabel(element: XmlElementNode): string {
  let out = '';
  const visit = (node: XmlNode) => {
    if (node.type === 'text') {
      out += node.value;
      return;
    }

    const alt = attr(node, 'alt');
    const title = attr(node, 'title');
    if (
      (node.localName === 'img' ||
        node.localName === 'area' ||
        node.localName === 'input') &&
      (alt || title)
    ) {
      out += alt ?? title ?? '';
      return;
    }

    for (const child of node.children) visit(child);
  };
  visit(element);
  const normalized = normalizeWhitespace(out);
  return normalized || normalizeWhitespace(attr(element, 'title') ?? '');
}

export function tokenList(value: string | undefined): string[] {
  if (!value) return [];
  return value.trim().split(/\s+/).filter(Boolean);
}

export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function parseStartTag(
  source: string,
  diagnostics: PublicationDiagnostic[],
  path?: PublicationPath,
  phase: DiagnosticPhase = 'package',
): { name: string; attributes: Record<string, string> } | null {
  let i = 0;
  skipWs();
  const name = readName();
  if (!name) {
    diagnostics.push(
      diag(
        'XML_INVALID_START_TAG',
        'error',
        'Start tag has no element name.',
        path,
        phase,
      ),
    );
    return null;
  }

  const attributes: Record<string, string> = {};
  while (i < source.length) {
    skipWs();
    if (i >= source.length) break;

    const attrName = readName();
    if (!attrName) {
      diagnostics.push(
        diag(
          'XML_INVALID_ATTRIBUTE',
          'error',
          `Invalid attribute syntax in <${name}>.`,
          path,
          phase,
        ),
      );
      break;
    }

    skipWs();
    if (source[i] !== '=') {
      diagnostics.push(
        diag(
          'XML_ATTRIBUTE_MISSING_EQUALS',
          'error',
          `Attribute ${attrName} is missing '='.`,
          path,
          phase,
        ),
      );
      attributes[attrName] = '';
      continue;
    }
    i += 1;
    skipWs();

    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      diagnostics.push(
        diag(
          'XML_ATTRIBUTE_NOT_QUOTED',
          'error',
          `Attribute ${attrName} is not quoted.`,
          path,
          phase,
        ),
      );
      const start = i;
      while (i < source.length && !/\s/.test(source[i]!)) i += 1;
      attributes[attrName] = decodeEntities(
        source.slice(start, i),
        diagnostics,
        path,
        phase,
      );
      continue;
    }

    i += 1;
    const start = i;
    const end = source.indexOf(quote, i);
    if (end < 0) {
      diagnostics.push(
        diag(
          'XML_UNTERMINATED_ATTRIBUTE',
          'error',
          `Attribute ${attrName} has no closing quote.`,
          path,
          phase,
        ),
      );
      attributes[attrName] = decodeEntities(
        source.slice(start),
        diagnostics,
        path,
        phase,
      );
      break;
    }
    attributes[attrName] = decodeEntities(
      source.slice(start, end),
      diagnostics,
      path,
      phase,
    );
    i = end + 1;
  }

  return { name, attributes };

  function skipWs() {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
  }

  function readName(): string {
    const start = i;
    while (i < source.length && /[A-Za-z0-9_.:-]/.test(source[i]!)) i += 1;
    return source.slice(start, i);
  }
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

function findDoctypeEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  let bracketDepth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '>' && bracketDepth === 0) return i;
  }
  return -1;
}

function decodeEntities(
  value: string,
  diagnostics: PublicationDiagnostic[],
  path?: PublicationPath,
  phase: DiagnosticPhase = 'package',
): string {
  return value.replace(
    /&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos|[A-Za-z_:][\w.:-]*);/g,
    (whole, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          if (entity.startsWith('#x'))
            return codePoint(entity.slice(2), 16, whole);
          if (entity.startsWith('#'))
            return codePoint(entity.slice(1), 10, whole);
          diagnostics.push(
            diag(
              'XML_EXTERNAL_OR_UNKNOWN_ENTITY',
              'warning',
              `Entity &${entity}; was not expanded because external/custom entities are disabled.`,
              path,
              phase,
            ),
          );
          return whole;
      }
    },
  );

  function codePoint(raw: string, radix: number, fallback: string): string {
    const cp = Number.parseInt(raw, radix);
    try {
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : fallback;
    } catch {
      return fallback;
    }
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\t\n\r ]+/g, ' ').trim();
}

function diag(
  code: string,
  severity: PublicationDiagnostic['severity'],
  message: string,
  path?: PublicationPath,
  phase: DiagnosticPhase = 'package',
): PublicationDiagnostic {
  return { code, severity, phase, message, path };
}
