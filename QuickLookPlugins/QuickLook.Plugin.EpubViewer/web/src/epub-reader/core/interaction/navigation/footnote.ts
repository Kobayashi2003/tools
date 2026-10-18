import { BrowserDomXmlPlatform } from '../../epub/content';
import {
  decodePublicationText,
  type ResourceResolver,
} from '../../epub/resources';

const MAX_FOOTNOTE_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_FOOTNOTE_PARAGRAPHS = 24;
const MAX_FOOTNOTE_CHARACTERS = 4_000;
const BLOCK_SELECTOR = 'p, li, blockquote, dd, dt';

export interface ReaderFootnote {
  readonly href: string;
  readonly label: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface FootnoteLinkActivation {
  readonly href: string;
  readonly label: string;
  readonly trigger: HTMLElement;
}

/** EPUB 3 and DPUB-ARIA both define explicit semantics for note references. */
export function isFootnoteReference(anchor: Element): boolean {
  return (
    tokenAttribute(anchor, 'epub:type').includes('noteref') ||
    tokenAttribute(anchor, 'type').includes('noteref') ||
    tokenAttribute(anchor, 'role').includes('doc-noteref')
  );
}

/**
 * Resolve a note from the publication container and expose text only. This
 * intentionally does not materialize publisher HTML, CSS, scripts or media in
 * the host UI.
 */
export async function loadPublicationFootnote(
  resolver: ResourceResolver,
  ownerDocument: Document,
  href: string,
  referenceLabel: string,
): Promise<ReaderFootnote | null> {
  const resolved = resolver.resolve('', href);
  const request = resolved.request;
  if (!request || request.remote || !request.path || !request.fragment)
    return null;

  const read = await resolver.readRequest(request);
  const resource = read.resource;
  if (!resource || resource.bytes.byteLength > MAX_FOOTNOTE_RESOURCE_BYTES)
    return null;
  if (!isDocumentMediaType(resource.mediaType)) return null;

  const platform = new BrowserDomXmlPlatform(ownerDocument);
  const source = decodePublicationText(resource.bytes, resource.mediaType);
  let document = platform.parseXml(source, 'application/xhtml+xml');
  if (document.querySelector('parsererror'))
    document = platform.parseXml(source, 'text/html');

  const target =
    document.getElementById(request.fragment) ??
    namedElement(document, request.fragment);
  if (!target) return null;

  const sanitized = target.cloneNode(true) as Element;
  sanitized
    .querySelectorAll(
      'script, style, template, noscript, [role="doc-backlink"], a[epub\\:type~="backlink"]',
    )
    .forEach((node) => node.remove());
  const title =
    firstText(sanitized.querySelector('h1, h2, h3, h4, h5, h6')) ||
    normalizedText(target.getAttribute('aria-label') ?? '') ||
    noteTitle(referenceLabel);
  sanitized
    .querySelectorAll('h1, h2, h3, h4, h5, h6')
    .forEach((node) => node.remove());
  const paragraphs = extractFootnoteParagraphs(sanitized);
  if (paragraphs.length === 0) return null;

  return Object.freeze({
    href,
    label: normalizedText(referenceLabel) || 'Note',
    title,
    paragraphs: Object.freeze(paragraphs),
  });
}

export function extractFootnoteParagraphs(root: Element): readonly string[] {
  const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)]
    .filter((block) => !block.parentElement?.closest(BLOCK_SELECTOR))
    .map(firstText)
    .filter(Boolean);
  const candidates =
    blocks.length > 0 ? blocks : [firstText(root)].filter(Boolean);
  const paragraphs: string[] = [];
  let remaining = MAX_FOOTNOTE_CHARACTERS;
  for (const candidate of candidates.slice(0, MAX_FOOTNOTE_PARAGRAPHS)) {
    if (remaining <= 0) break;
    const text =
      candidate.length > remaining
        ? `${candidate.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`
        : candidate;
    if (text) paragraphs.push(text);
    remaining -= text.length;
  }
  return paragraphs;
}

function tokenAttribute(element: Element, name: string): readonly string[] {
  return (element.getAttribute(name) ?? '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function namedElement(document: Document, name: string): Element | null {
  return (
    [...document.getElementsByTagName('*')].find(
      (element) => element.getAttribute('name') === name,
    ) ?? null
  );
}

function firstText(element: Element | null): string {
  return normalizedText(element?.textContent ?? '');
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function noteTitle(label: string): string {
  const normalized = normalizedText(label);
  return normalized ? `Footnote ${normalized}` : 'Footnote';
}

function isDocumentMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    essence === 'application/xhtml+xml' ||
    essence === 'text/html' ||
    essence === 'application/xml' ||
    essence === 'text/xml'
  );
}
