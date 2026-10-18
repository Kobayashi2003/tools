import type { PublicationContentDocumentPipeline } from '../../epub/content';
import {
  createDomPath,
  createEpubCfi,
  parseEpubCfi,
} from '../../interaction/locator';
import type { Publication } from '../../epub/publication';
import {
  buildSemanticTextProjection,
  type SemanticTextSegment,
} from '../../epub/text';
import type {
  SearchDocument,
  SearchDocumentProvider,
  SearchTextSegment,
} from './model';

export class BrowserPublicationSearchProvider implements SearchDocumentProvider {
  constructor(
    private readonly publication: Publication,
    private readonly contentPipeline: PublicationContentDocumentPipeline,
  ) {}

  async load(
    spineIndex: number,
    signal: AbortSignal,
  ): Promise<SearchDocument | null> {
    throwIfAborted(signal);
    const document = await this.build(spineIndex, signal);
    throwIfAborted(signal);
    return document;
  }

  private async build(
    spineIndex: number,
    signal: AbortSignal,
  ): Promise<SearchDocument | null> {
    const item = this.publication.spine[spineIndex];
    if (!item?.path || item.remote) return null;
    const media = item.mediaType.split(';', 1)[0]?.trim().toLowerCase();
    if (
      media !== 'application/xhtml+xml' &&
      media !== 'text/html' &&
      media !== 'image/svg+xml'
    )
      return null;
    const parsedContent = await this.contentPipeline.parseForAnalysis(
      item,
      signal,
    );
    const parsed = parsedContent.document;
    removeExecutableScripts(parsed);
    const root = parsed.body ?? parsed.documentElement;
    if (!root) return null;
    const projection = buildSemanticTextProjection(parsed, root);
    const text = projection.text;
    const segments = projection.segments.map((segment) =>
      lightweightSegment(parsed, item, segment),
    );

    return {
      spineIndex,
      href: item.href,
      text,
      diagnostics: parsedContent.diagnostics,
      segments,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Search aborted.', 'AbortError');
}

function lightweightSegment(
  document: Document,
  item: Publication['spine'][number],
  segment: SemanticTextSegment,
): SearchTextSegment {
  const point = { node: segment.node, offset: 0 };
  let cfi: SearchTextSegment['cfi'];
  try {
    const parsed = parseEpubCfi(createEpubCfi(item, document, point));
    cfi = { packagePath: parsed.packagePath, contentPath: parsed.contentPath };
  } catch {
    // Text quote, DOM path and progression remain independent restore channels.
  }
  const dom = createDomPath(document, point);
  const fragment = nearestElementId(segment.node);
  return {
    start: segment.start,
    end: segment.end,
    sourceBoundaries: [...segment.sourceBoundaries],
    ...(cfi ? { cfi } : {}),
    ...(fragment ? { fragment } : {}),
    ...(dom ? { dom } : {}),
  };
}

function nearestElementId(node: Node): string | undefined {
  let element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (element) {
    if (element.id) return element.id;
    element = element.parentElement;
  }
  return undefined;
}

function removeExecutableScripts(document: Document): void {
  for (const script of Array.from(document.getElementsByTagName('script')))
    script.remove();
  for (const script of Array.from(
    document.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'script'),
  ))
    script.remove();
}
