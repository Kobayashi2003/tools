export type W3cTestResult = true | false | 'n/a' | null;

/** Shape accepted by the W3C EPUB test repository implementation reports. */
export interface W3cImplementationReport {
  readonly name: string;
  readonly ref?: string;
  readonly variant?: string;
  readonly tested_by?: 'implementer' | 'third-party';
  readonly tests: Readonly<Record<string, W3cTestResult>>;
}

export interface ConformanceCaseResult {
  readonly id: string;
  readonly result: W3cTestResult;
  readonly notes?: string;
}

export interface ConformanceSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
  readonly notRun: number;
}
