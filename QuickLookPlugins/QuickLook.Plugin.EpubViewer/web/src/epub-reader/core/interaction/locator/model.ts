import type { Locator } from '../../epub/publication';

export type LocatorRestoreMethod =
  | 'cfi'
  | 'fragment'
  | 'text-quote'
  | 'dom-path'
  | 'progression'
  | 'resource-start';

export interface LocatorRestoreResult {
  readonly locator: Locator;
  readonly method: LocatorRestoreMethod;
  readonly correctedCfi?: string;
}

/** Parsed point-CFI subset used by the reading engine. */
export interface ParsedEpubCfi {
  readonly raw: string;
  readonly packagePath: CfiPath;
  readonly contentPath: CfiPath;
}

export interface CfiPath {
  readonly steps: readonly CfiStep[];
  readonly characterOffset?: number;
  readonly textAssertion?: CfiTextAssertion;
  readonly sideBias?: 'before' | 'after';
}

export interface CfiTextAssertion {
  readonly before?: string;
  readonly after?: string;
}

export interface CfiStep {
  readonly index: number;
  readonly assertion?: string;
}

export interface DomPoint {
  readonly node: Node;
  readonly offset: number;
}
