import { runContentDocumentCompatibility } from '../compatibility/content-runner';
import {
  compatibilityProfileSignature,
  type CompatibilityProfile,
} from '../compatibility/profile';
import type { SpineItem } from '../publication';
import {
  decodePublicationText,
  type PublicationResourceSession,
} from '../resources';
import { materializeSvgSpineItem } from './svg-materializer';
import {
  materializeParsedXhtmlSpineItem,
  parseXhtmlContentDocument,
} from './xhtml-materializer';
import type {
  BrowserXmlPlatform,
  MaterializedContentDocument,
  ParsedContentDocument,
} from './model';

/**
 * The only publication-session entry point for content parsing.
 * Analysis and rendering therefore share the same immutable compatibility
 * profile even though rendering performs additional resource rewriting.
 */
export class PublicationContentDocumentPipeline {
  readonly analysisSignature: string;
  readonly renderSignature: string;
  private readonly compatibilityProfile: CompatibilityProfile;

  constructor(
    private readonly resources: PublicationResourceSession,
    private readonly platform: BrowserXmlPlatform,
  ) {
    this.compatibilityProfile = resources.resolver.compatibilityProfile;
    const compatibilityProfile = this.compatibilityProfile;
    this.analysisSignature = compatibilityProfileSignature(
      compatibilityProfile.contentDocumentRules,
    );
    this.renderSignature = compatibilityProfileSignature([
      ...compatibilityProfile.contentDocumentRules,
      ...compatibilityProfile.resourceRules,
    ]);
  }

  async parseForAnalysis(
    item: SpineItem,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ParsedContentDocument> {
    assertLocalContentItem(item);
    throwIfAborted(signal);
    const read = await this.resources.resolver.read('', item.path!);
    throwIfAborted(signal);
    if (!read.resource)
      throw new Error(`Unable to read content document ${item.path}.`);
    const source = decodePublicationText(
      read.resource.bytes,
      read.resource.mediaType,
    );
    const mediaType = normalizedMediaType(item.mediaType);

    if (mediaType === 'image/svg+xml') {
      const document = this.platform.parseXml(source, 'image/svg+xml');
      if (
        !document.documentElement ||
        document.getElementsByTagName('parsererror').length > 0
      ) {
        throw new Error(
          `SVG content document is not well-formed XML: ${item.path}.`,
        );
      }
      return { document, diagnostics: read.diagnostics };
    }

    let standard: ParsedContentDocument | undefined;
    let standardParseError: unknown;
    try {
      standard = parseXhtmlContentDocument(
        source,
        item.path!,
        this.platform,
        'xml',
      );
    } catch (error) {
      standardParseError = error;
    }
    const compatible = await runContentDocumentCompatibility(
      this.compatibilityProfile.contentDocumentRules,
      {
        path: item.path!,
        spineItem: item,
        mediaType: item.mediaType,
        authoredSource: source,
        standardParseError,
      },
      { source, parseMode: 'xml', hints: {} },
    );
    throwIfAborted(signal);

    const parsed =
      standard &&
      compatible.value.parseMode === 'xml' &&
      compatible.value.source === source
        ? standard
        : parseXhtmlContentDocument(
            compatible.value.source,
            item.path!,
            this.platform,
            compatible.value.parseMode,
          );
    return {
      document: parsed.document,
      diagnostics: Object.freeze([
        ...read.diagnostics,
        ...compatible.diagnostics,
        ...parsed.diagnostics,
      ]),
    };
  }

  async materializeForRender(
    item: SpineItem,
  ): Promise<MaterializedContentDocument> {
    assertLocalContentItem(item);
    if (normalizedMediaType(item.mediaType) === 'image/svg+xml') {
      return materializeSvgSpineItem(item, this.resources, this.platform);
    }
    const parsed = await this.parseForAnalysis(item);
    return materializeParsedXhtmlSpineItem(
      item,
      this.resources,
      this.platform,
      parsed,
      {
        disableScripts: true,
        annotateLinks: true,
      },
    );
  }
}

function assertLocalContentItem(item: SpineItem): void {
  if (item.remote || !item.path) {
    throw new Error(
      `Content document pipeline requires a container-local spine item: ${item.href}.`,
    );
  }
  const mediaType = normalizedMediaType(item.mediaType);
  if (
    !['application/xhtml+xml', 'text/html', 'image/svg+xml'].includes(mediaType)
  ) {
    throw new Error(
      `Unsupported content document media type ${item.mediaType}.`,
    );
  }
}

function normalizedMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Content parsing aborted.', 'AbortError');
}
