import type {
  ContentPresentationHints,
  PublicationDiagnostic,
  PublicationPath,
} from '../publication';

export interface MaterializedContentDocument {
  readonly sourcePath: PublicationPath;
  /** Rewritten, script-disabled markup retained for srcdoc fallback surfaces. */
  readonly markup: string;
  readonly url: string;
  readonly mediaType: string;
  readonly hints: ContentPresentationHints;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface ParsedContentDocument {
  readonly document: Document;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface BrowserXmlPlatform {
  parseXml(source: string, mediaType: DOMParserSupportedType): Document;
  serializeXml(document: Document): string;
}

export interface XhtmlMaterializerOptions {
  /** Remove authored script bodies/sources when scripting is unsupported. */
  readonly disableScripts?: boolean;
  /** Preserve http(s) anchors as metadata but prevent iframe navigation later. */
  readonly annotateLinks?: boolean;
}
