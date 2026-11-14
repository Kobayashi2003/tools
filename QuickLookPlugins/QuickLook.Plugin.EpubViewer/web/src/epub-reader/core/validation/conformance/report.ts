import type {
  ConformanceCaseResult,
  ConformanceSummary,
  W3cImplementationReport,
  W3cTestResult,
} from './model';

export class W3cConformanceRecorder {
  private readonly results = new Map<string, W3cTestResult>();

  constructor(
    private readonly identity: Omit<W3cImplementationReport, 'tests'>,
  ) {}

  record(id: string, result: W3cTestResult): void {
    const normalized = id.trim();
    if (!normalized)
      throw new Error('W3C conformance test id cannot be empty.');
    this.results.set(normalized, result);
  }

  recordAll(cases: readonly ConformanceCaseResult[]): void {
    for (const item of cases) this.record(item.id, item.result);
  }

  report(): W3cImplementationReport {
    return Object.freeze({
      ...this.identity,
      tests: Object.freeze(
        Object.fromEntries(
          [...this.results.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    });
  }

  summary(): ConformanceSummary {
    return summarizeW3cResults([...this.results.values()]);
  }
}

export function summarizeW3cResults(
  results: Iterable<W3cTestResult>,
): ConformanceSummary {
  let passed = 0;
  let failed = 0;
  let notApplicable = 0;
  let notRun = 0;
  for (const result of results) {
    if (result === true) passed += 1;
    else if (result === false) failed += 1;
    else if (result === 'n/a') notApplicable += 1;
    else notRun += 1;
  }
  return {
    total: passed + failed + notApplicable + notRun,
    passed,
    failed,
    notApplicable,
    notRun,
  };
}
