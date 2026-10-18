import type { ReaderMarkStore } from '../annotations';
import type { Publication } from '../../epub/publication';
import type { RendererContentDocument } from '../../presentation/renderer';
import type { SearchHit } from '../search';
import { DomDecorationLayer } from './dom-decoration-layer';
import type {
  DecorationTheme,
  ReaderDecoration,
  ReaderDecorationActivation,
} from './model';

export interface DecorationDocumentSource {
  readonly contentDocuments: readonly RendererContentDocument[];
  onStateChange?(
    listener: (
      state: import('../../presentation/renderer').RendererHostState,
    ) => void,
  ): () => void;
}

/** Bridges persistent marks + ephemeral search results onto whatever documents are currently live. */
export class ReaderDecorationController {
  private readonly layers = new Map<Document, DomDecorationLayer>();
  private searchHits: readonly SearchHit[] = [];
  private currentSearchId: string | null = null;
  private unsubscribeMarks: (() => void) | null = null;
  private unsubscribeHost: (() => void) | null = null;
  private persistent: readonly ReaderDecoration[] = [];

  constructor(
    private readonly publication: Publication,
    private readonly source: DecorationDocumentSource,
    store?: ReaderMarkStore,
    private readonly theme?: DecorationTheme,
    private readonly onActivate?: (
      activation: ReaderDecorationActivation,
    ) => boolean,
  ) {
    if (store) {
      this.unsubscribeMarks = store.subscribe((snapshot) => {
        this.persistent = snapshot.marks
          .filter((mark) => mark.kind !== 'bookmark')
          .map((mark) => ({
            id: mark.id,
            range: mark.range,
            intent: mark.highlight,
            color: mark.color,
            ...(mark.label ? { ariaLabel: mark.label } : {}),
          }));
        this.sync();
      });
    }
    if (source.onStateChange)
      this.unsubscribeHost = source.onStateChange(() => this.sync());
    this.sync();
  }

  setSearchHits(
    hits: readonly SearchHit[],
    currentId: string | null = null,
  ): void {
    this.searchHits = hits;
    this.currentSearchId = currentId;
    this.sync();
  }

  refresh(): void {
    for (const layer of this.layers.values()) layer.refresh();
  }

  dispose(): void {
    this.unsubscribeMarks?.();
    this.unsubscribeHost?.();
    for (const layer of this.layers.values()) layer.dispose();
    this.layers.clear();
  }

  private sync(): void {
    const live = new Set(
      this.source.contentDocuments.map((context) => context.document),
    );
    for (const [document, layer] of this.layers) {
      if (!live.has(document)) {
        layer.dispose();
        this.layers.delete(document);
      }
    }

    const search: ReaderDecoration[] = this.searchHits.map((hit) => ({
      id: hit.id,
      range: hit.range,
      intent: hit.id === this.currentSearchId ? 'search-current' : 'search',
    }));
    const all = [...this.persistent, ...search];
    for (const context of this.source.contentDocuments) {
      let layer = this.layers.get(context.document);
      if (!layer) {
        layer = new DomDecorationLayer(
          context,
          this.publication,
          this.theme,
          this.onActivate,
        );
        this.layers.set(context.document, layer);
      }
      const relevant = all.filter((decoration) =>
        intersectsSpine(decoration, context.spineIndex),
      );
      layer.setDecorations(relevant);
    }
  }
}

function intersectsSpine(
  decoration: ReaderDecoration,
  spineIndex: number,
): boolean {
  const min = Math.min(
    decoration.range.start.spineIndex,
    decoration.range.end.spineIndex,
  );
  const max = Math.max(
    decoration.range.start.spineIndex,
    decoration.range.end.spineIndex,
  );
  return spineIndex >= min && spineIndex <= max;
}
