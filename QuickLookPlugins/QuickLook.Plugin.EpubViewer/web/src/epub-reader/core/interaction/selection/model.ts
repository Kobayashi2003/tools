import type { LocatorRange } from '../../epub/publication';

export interface ReaderSelection {
  readonly range: LocatorRange;
  readonly text: string;
  readonly collapsed: boolean;
}
