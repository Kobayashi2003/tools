import type { Locator } from '../../epub/publication';
import type { RendererLayoutSnapshot } from '../../presentation/renderer';

export interface ReaderAccessibilityDescription {
  readonly locator: Locator | null;
  readonly chapter?: string;
  readonly page?: string;
  readonly progress?: string;
  readonly announcement: string;
}

export interface ReaderAccessibilityInput {
  readonly locator: Locator | null;
  readonly layout: RendererLayoutSnapshot | null;
}
