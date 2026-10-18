import type { PublicationArchive } from '../archive';
import { createBuiltInCompatibilityProfile } from '../compatibility/built-in-rules';
import { runContentDocumentCompatibility } from '../compatibility/content-runner';
import type { CompatibilityProfile } from '../compatibility/profile';
import {
  resolvePublicationReference,
  resolveSpineRendition,
  DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  type ContentPageProfile,
  type ContentPresentationHints,
  type IntrinsicViewport,
  type Publication,
  type PublicationDiagnostic,
  type PublicationPath,
} from '../publication';
import { parseXml, type XmlElementNode } from '../xml';
import { semanticXmlText } from '../text';
import { imageDimensions } from './preflight/image-dimensions';
import { inspectSvgImage } from './preflight/svg-image';
import {
  inspectPresentation,
  stripCssComments,
} from './preflight/presentation-inspector';

export { imageDimensions } from './preflight/image-dimensions';

export interface PublicationContentPreflightResult {
  readonly hints: ReadonlyMap<number, ContentPresentationHints>;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

interface PublicationContentPreflightItemResult {
  readonly item: Publication['spine'][number];
  readonly hint?: ContentPresentationHints;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

/**
 * Deduplicated, publication-scoped content inspection. Callers can inspect a
 * small render-critical window first and reuse the same per-item work while a
 * later background pass completes the publication profile.
 */
export class PublicationContentPreflightSession {
  private readonly controller = new AbortController();
  private readonly itemResults = new Map<
    number,
    Promise<PublicationContentPreflightItemResult>
  >();
  private readonly stylesheetCache = new Map<
    PublicationPath,
    Promise<string>
  >();
  private detachParentSignalCallback: (() => void) | null;
  private disposed = false;

  constructor(
    private readonly archive: PublicationArchive,
    private readonly publication: Publication,
    parentSignal?: AbortSignal,
    private readonly compatibilityProfile: CompatibilityProfile = createBuiltInCompatibilityProfile(
      DEFAULT_READER_COMPATIBILITY_PREFERENCES,
    ),
  ) {
    const abortFromParent = () => this.controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
      this.detachParentSignalCallback = null;
    } else if (parentSignal) {
      parentSignal.addEventListener('abort', abortFromParent, { once: true });
      this.detachParentSignalCallback = () =>
        parentSignal.removeEventListener('abort', abortFromParent);
    } else {
      this.detachParentSignalCallback = null;
    }
  }

  async inspect(
    spineIndexes: readonly number[] = this.publication.spine.map(
      (item) => item.index,
    ),
  ): Promise<PublicationContentPreflightResult> {
    this.assertAlive();
    throwIfAborted(this.controller.signal);
    const indexes = [...new Set(spineIndexes)].sort((a, b) => a - b);
    const items = indexes.map((index) => {
      const item = this.publication.spine[index];
      if (!item)
        throw new RangeError(
          `Spine index ${index} is outside the publication.`,
        );
      return item;
    });
    const results = await mapWithConcurrency(items, 4, (item) =>
      this.resultFor(item),
    );
    const hints = new Map<number, ContentPresentationHints>();
    const diagnostics: PublicationDiagnostic[] = [];
    for (const result of results) {
      if (result.hint) hints.set(result.item.index, result.hint);
      diagnostics.push(...result.diagnostics);
    }
    return { hints, diagnostics };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachParentSignal();
    this.controller.abort(
      new DOMException('Publication preflight session disposed.', 'AbortError'),
    );
    this.itemResults.clear();
    this.stylesheetCache.clear();
  }

  /** Opening cancellation stops owning the session after the reader is ready. */
  detachParentSignal(): void {
    this.detachParentSignalCallback?.();
    this.detachParentSignalCallback = null;
  }

  private resultFor(
    item: Publication['spine'][number],
  ): Promise<PublicationContentPreflightItemResult> {
    let pending = this.itemResults.get(item.index);
    if (!pending) {
      pending = inspectPublicationContentItem(
        this.archive,
        this.publication,
        item,
        this.stylesheetCache,
        this.controller.signal,
        this.compatibilityProfile,
      );
      this.itemResults.set(item.index, pending);
    }
    return pending;
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('PublicationContentPreflightSession has been disposed.');
  }
}

/**
 * Inspect content before the first renderer plan. This intentionally handles a
 * narrow but high-value CSS subset (html/body class/id + writing-mode/direction)
 * so Japanese EPUB templates such as `.vrtl` do not begin with a false
 * horizontal plan and then self-correct only after iframe layout.
 */
export async function preflightPublicationContent(
  archive: PublicationArchive,
  publication: Publication,
  signal: AbortSignal = new AbortController().signal,
  compatibilityProfile: CompatibilityProfile = createBuiltInCompatibilityProfile(
    DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  ),
): Promise<PublicationContentPreflightResult> {
  const session = new PublicationContentPreflightSession(
    archive,
    publication,
    signal,
    compatibilityProfile,
  );
  try {
    return await session.inspect();
  } finally {
    session.dispose();
  }
}

async function inspectPublicationContentItem(
  archive: PublicationArchive,
  publication: Publication,
  item: Publication['spine'][number],
  stylesheetCache: Map<PublicationPath, Promise<string>>,
  signal: AbortSignal,
  compatibilityProfile: CompatibilityProfile,
): Promise<PublicationContentPreflightItemResult> {
  throwIfAborted(signal);
  const itemDiagnostics: PublicationDiagnostic[] = [];
  if (!item.path || item.remote || !archive.has(item.path))
    return { item, diagnostics: itemDiagnostics };
  const media = item.mediaType.split(';', 1)[0]?.trim().toLowerCase();
  if (
    media !== 'application/xhtml+xml' &&
    media !== 'text/html' &&
    media !== 'image/svg+xml'
  )
    return { item, diagnostics: itemDiagnostics };

  try {
    if (media === 'image/svg+xml') {
      const source = await archive.readText(item.path);
      throwIfAborted(signal);
      const parsed = parseXml(source, item.path, 'content');
      itemDiagnostics.push(...parsed.diagnostics);
      if (!parsed.root) return { item, diagnostics: itemDiagnostics };
      const viewport = svgViewport(parsed.root);
      const hint: ContentPresentationHints = {
        ...(viewport ? { viewport } : {}),
        page: {
          kind: 'single-svg-page',
          pageLike: true,
          semanticTextLength: semanticXmlText(parsed.root).length,
          replacedElementCount: 1,
          ...(viewport ? { intrinsicViewport: viewport } : {}),
        },
      };
      return { item, hint, diagnostics: itemDiagnostics };
    }

    const source = await archive.readText(item.path);
    throwIfAborted(signal);
    const parsed = parseXml(source, item.path, 'content');
    // Preflight is advisory. Browser materialization has an HTML-parser
    // compatibility fallback, so XML well-formedness failures here must not
    // prematurely classify an otherwise recoverable book as degraded.
    itemDiagnostics.push(
      ...parsed.diagnostics.map((diagnostic) =>
        diagnostic.severity === 'error'
          ? { ...diagnostic, severity: 'warning' as const }
          : diagnostic,
      ),
    );
    if (!parsed.root) return { item, diagnostics: itemDiagnostics };
    const html = parsed.root;
    const body = findFirst(html, 'body') ?? html;
    const css = await collectDocumentCss(
      archive,
      item.path,
      html,
      itemDiagnostics,
      stylesheetCache,
    );
    throwIfAborted(signal);
    const presentation = inspectPresentation(html, body, css);
    const page = await classifyPage(
      archive,
      item.path,
      body,
      resolveSpineRendition(publication, item).layout === 'reflowable',
      itemDiagnostics,
    );
    throwIfAborted(signal);
    const baseHint: ContentPresentationHints = {
      ...(presentation.writingMode && !presentation.legacyWritingMode
        ? { writingMode: presentation.writingMode }
        : {}),
      ...(presentation.direction ? { direction: presentation.direction } : {}),
      ...(page.intrinsicViewport ? { viewport: page.intrinsicViewport } : {}),
      page,
    };
    const compatible = await runContentDocumentCompatibility(
      compatibilityProfile.contentDocumentRules,
      {
        path: item.path,
        spineItem: item,
        mediaType: item.mediaType,
        authoredSource: source,
        presentationCandidate: {
          writingMode: presentation.writingMode,
          direction: presentation.direction,
          writingModeSource: presentation.legacyWritingMode
            ? 'legacy'
            : 'standard',
        },
      },
      { source, parseMode: 'xml', hints: baseHint },
    );
    itemDiagnostics.push(...compatible.diagnostics);
    const hint = compatible.value.hints;

    if (
      page.pageLike &&
      resolveSpineRendition(publication, item).layout === 'reflowable'
    ) {
      itemDiagnostics.push({
        code: page.likelySpanningSpread
          ? 'CONTENT_REFLOWABLE_UNMARKED_SPANNING_IMAGE'
          : 'CONTENT_REFLOWABLE_PAGE_LIKE_IMAGE',
        severity: 'info',
        phase: 'compatibility',
        path: item.path,
        spineIndex: item.index,
        message: page.likelySpanningSpread
          ? 'A reflowable spine item is structurally a single landscape image and is treated as an unmarked spread-sized page.'
          : 'A reflowable spine item is structurally a single image page and may participate in cross-spine page composition.',
        repair: {
          strategy: page.likelySpanningSpread
            ? 'classify-reflowable-image-as-spanning-page'
            : 'classify-reflowable-image-as-page-like',
          description:
            'Preserve the authored reflowable declaration while using content structure to choose a page-like spread execution strategy.',
          confidence: page.likelySpanningSpread ? 0.9 : 0.96,
        },
      });
    }
    return { item, hint, diagnostics: itemDiagnostics };
  } catch (cause) {
    if (signal.aborted) throw cause;
    itemDiagnostics.push({
      code: 'CONTENT_PREFLIGHT_FAILED',
      severity: 'warning',
      phase: 'content',
      path: item.path,
      spineIndex: item.index,
      message: `Content preflight failed for ${item.path}; renderer-side inspection will remain available.`,
      cause,
    });
    return { item, diagnostics: itemDiagnostics };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Publication preflight aborted.', 'AbortError');
}

async function classifyPage(
  archive: PublicationArchive,
  documentPath: PublicationPath,
  body: XmlElementNode,
  globallyReflowable: boolean,
  diagnostics: PublicationDiagnostic[],
): Promise<ContentPageProfile> {
  const text = semanticXmlText(body);
  const images = descendantsByName(body, 'img');
  const svg = descendantsByName(body, 'svg');
  const svgImage =
    svg.length === 1 && !text.trim() ? inspectSvgImage(svg[0]!) : undefined;
  const replacedElementCount =
    images.length +
    svg.length +
    descendantsByName(body, 'video').length +
    descendantsByName(body, 'object').length +
    descendantsByName(body, 'embed').length;

  if (
    (images.length === 1 || svgImage != null) &&
    text.trim().length <= 16 &&
    replacedElementCount === 1
  ) {
    const source = svgImage?.source ?? images[0]?.attributes.src?.trim();
    let viewport: IntrinsicViewport | undefined = svgImage?.viewport;
    if (source && !viewport) {
      try {
        const resolved = resolvePublicationReference(documentPath, source);
        if (!resolved.remote && resolved.path && archive.has(resolved.path)) {
          viewport = imageDimensions(await archive.read(resolved.path));
        }
      } catch (cause) {
        diagnostics.push({
          code: 'CONTENT_PREFLIGHT_IMAGE_REFERENCE_FAILED',
          severity: 'info',
          phase: 'content',
          path: documentPath,
          message: `Could not inspect the single-image page resource ${source}.`,
          cause,
        });
      }
    }
    const aspect = viewport ? viewport.width / viewport.height : undefined;
    return {
      kind: svgImage ? 'single-svg-page' : 'single-image-page',
      pageLike: true,
      semanticTextLength: text.length,
      replacedElementCount,
      ...(viewport ? { intrinsicViewport: viewport } : {}),
      ...(globallyReflowable && aspect != null && aspect >= 1.18
        ? { likelySpanningSpread: true }
        : {}),
    };
  }

  return {
    kind: text.trim() ? 'flowing-text' : 'unknown',
    pageLike: false,
    semanticTextLength: text.length,
    replacedElementCount,
  };
}

async function collectDocumentCss(
  archive: PublicationArchive,
  documentPath: PublicationPath,
  html: XmlElementNode,
  diagnostics: PublicationDiagnostic[],
  cache: Map<PublicationPath, Promise<string>>,
): Promise<string[]> {
  const paths: PublicationPath[] = [];
  for (const link of descendantsByName(html, 'link')) {
    const rel = (link.attributes.rel ?? '').toLowerCase().split(/\s+/u);
    const href = link.attributes.href?.trim();
    // `rel="alternate stylesheet"` is not applied until a user picks it. The
    // Japanese vertical/horizontal sheet pair ships the unused half this way,
    // so loading it makes the wrong writing mode win the cascade.
    if (!href || !rel.includes('stylesheet') || rel.includes('alternate'))
      continue;
    try {
      const ref = resolvePublicationReference(documentPath, href);
      if (!ref.remote && ref.path) paths.push(ref.path);
    } catch {
      /* renderer/resource diagnostics remain authoritative */
    }
  }
  const out: string[] = [];
  const seen = new Set<PublicationPath>();
  const visit = async (path: PublicationPath): Promise<void> => {
    if (seen.has(path) || !archive.has(path)) return;
    seen.add(path);
    try {
      let pending = cache.get(path);
      if (!pending) {
        pending = archive.readText(path);
        cache.set(path, pending);
      }
      const css = await pending;
      out.push(css);
      for (const imported of cssImports(css)) {
        try {
          const ref = resolvePublicationReference(path, imported);
          if (!ref.remote && ref.path) await visit(ref.path);
        } catch {
          /* ignore malformed import here */
        }
      }
    } catch (cause) {
      diagnostics.push({
        code: 'CONTENT_PREFLIGHT_STYLESHEET_READ_FAILED',
        severity: 'info',
        phase: 'content',
        path,
        message: `Could not inspect stylesheet ${path} during presentation preflight.`,
        cause,
      });
    }
  };
  for (const path of paths) await visit(path);
  return out;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      run,
    ),
  );
  return results;
}

function cssImports(css: string): string[] {
  const clean = stripCssComments(css);
  const out: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/giu;
  for (const match of clean.matchAll(pattern)) if (match[1]) out.push(match[1]);
  return out;
}

function descendantsByName(
  root: XmlElementNode,
  name: string,
): XmlElementNode[] {
  const out: XmlElementNode[] = [];
  const visit = (node: XmlElementNode) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (child.localName.toLowerCase() === name) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function findFirst(
  root: XmlElementNode,
  name: string,
): XmlElementNode | undefined {
  if (root.localName.toLowerCase() === name) return root;
  for (const child of root.children) {
    if (child.type !== 'element') continue;
    const found = findFirst(child, name);
    if (found) return found;
  }
  return undefined;
}

function svgViewport(root: XmlElementNode): IntrinsicViewport | undefined {
  const viewBox = root.attributes.viewBox ?? root.attributes.viewbox;
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number);
    if (
      parts.length === 4 &&
      Number.isFinite(parts[2]) &&
      Number.isFinite(parts[3]) &&
      parts[2]! > 0 &&
      parts[3]! > 0
    ) {
      return { width: parts[2]!, height: parts[3]! };
    }
  }
  const width = cssNumeric(root.attributes.width);
  const height = cssNumeric(root.attributes.height);
  return width && height ? { width, height } : undefined;
}

function cssNumeric(value: string | undefined): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)/u.exec(value ?? '');
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
