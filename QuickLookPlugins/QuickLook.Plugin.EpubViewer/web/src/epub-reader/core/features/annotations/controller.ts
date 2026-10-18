import type { ReaderNavigator } from '../../interaction/navigation';
import type { RendererHost } from '../../presentation/renderer';
import type { LocatorRange } from '../../epub/publication';
import { createMarkId } from './store';
import type {
  Annotation,
  AnnotationColor,
  AnnotationHighlightStyle,
  Bookmark,
  Highlight,
  ReaderMark,
  ReaderMarkPatch,
  ReaderMarkStore,
} from './model';

export class ReaderMarkController {
  constructor(
    private readonly store: ReaderMarkStore,
    private readonly host: Pick<RendererHost, 'captureLocator'>,
    private readonly navigator: Pick<ReaderNavigator, 'goToLocator'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async addBookmark(label?: string): Promise<Bookmark | null> {
    const locator = await this.host.captureLocator();
    if (!locator) return null;
    const stamp = this.now().toISOString();
    const mark: Bookmark = {
      id: createMarkId('bookmark'),
      kind: 'bookmark',
      locator,
      createdAt: stamp,
      updatedAt: stamp,
      ...(label ? { label } : {}),
    };
    this.store.put(mark);
    return mark;
  }

  addHighlight(
    range: LocatorRange,
    highlight: AnnotationHighlightStyle = 'solid',
    color: AnnotationColor = 'yellow',
    label?: string,
    tags?: readonly string[],
  ): Highlight {
    const stamp = this.now().toISOString();
    const mark: Highlight = {
      id: createMarkId('highlight'),
      kind: 'highlight',
      range,
      highlight,
      color,
      createdAt: stamp,
      updatedAt: stamp,
      ...(label ? { label } : {}),
      ...(tags?.length ? { tags: [...tags] } : {}),
    };
    this.store.put(mark);
    return mark;
  }

  addAnnotation(
    range: LocatorRange,
    body: string,
    highlight: AnnotationHighlightStyle = 'solid',
    color: AnnotationColor = 'yellow',
    label?: string,
    tags?: readonly string[],
  ): Annotation {
    const stamp = this.now().toISOString();
    const mark: Annotation = {
      id: createMarkId('annotation'),
      kind: 'annotation',
      range,
      body,
      highlight,
      color,
      createdAt: stamp,
      updatedAt: stamp,
      ...(label ? { label } : {}),
      ...(tags?.length ? { tags: [...tags] } : {}),
    };
    this.store.put(mark);
    return mark;
  }

  update(id: string, patch: ReaderMarkPatch): ReaderMark | null {
    const existing = this.store.snapshot().marks.find((mark) => mark.id === id);
    if (!existing) return null;
    const updatedAt = this.now().toISOString();
    let updated: ReaderMark;
    if (existing.kind === 'bookmark') {
      updated = {
        ...existing,
        updatedAt,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.tags !== undefined
          ? { tags: normalizeTags(patch.tags) }
          : {}),
      };
    } else if (existing.kind === 'highlight') {
      updated = {
        ...existing,
        updatedAt,
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.highlight ? { highlight: patch.highlight } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.tags !== undefined
          ? { tags: normalizeTags(patch.tags) }
          : {}),
      };
    } else {
      updated = {
        ...existing,
        updatedAt,
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.color ? { color: patch.color } : {}),
        ...(patch.highlight ? { highlight: patch.highlight } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.tags !== undefined
          ? { tags: normalizeTags(patch.tags) }
          : {}),
      };
    }
    this.store.put(updated);
    return updated;
  }

  async goToMark(
    mark: Bookmark | Highlight | Annotation,
  ): Promise<import('../../epub/publication').Locator | null> {
    return this.navigator.goToLocator(
      mark.kind === 'bookmark' ? mark.locator : mark.range.start,
    );
  }
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
