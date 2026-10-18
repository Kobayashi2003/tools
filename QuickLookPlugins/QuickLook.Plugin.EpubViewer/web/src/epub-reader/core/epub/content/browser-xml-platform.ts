import type { BrowserXmlPlatform } from './model';

/**
 * DOMParser/XMLSerializer adapter sourced from the host browsing context. This
 * avoids assuming browser globals exist when the headless core is imported in
 * Node, SSR, or a worker.
 */
export class BrowserDomXmlPlatform implements BrowserXmlPlatform {
  private readonly Parser: typeof DOMParser;
  private readonly Serializer: typeof XMLSerializer;

  constructor(ownerDocument: Document) {
    const win = ownerDocument.defaultView;
    if (!win?.DOMParser || !win.XMLSerializer) {
      throw new Error(
        'The owner document does not expose DOMParser/XMLSerializer.',
      );
    }
    this.Parser = win.DOMParser;
    this.Serializer = win.XMLSerializer;
  }

  parseXml(source: string, mediaType: DOMParserSupportedType): Document {
    return new this.Parser().parseFromString(source, mediaType);
  }

  serializeXml(document: Document): string {
    return new this.Serializer().serializeToString(document);
  }
}
