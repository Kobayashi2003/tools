import { loadEpub, type PublicationDiagnostic } from '../../epub/publication';
import {
  createCompatibilityReport,
  type CompatibilityStatus,
} from '../../epub/compatibility';
import type { OcfZipLimits } from '../../epub/archive';

export interface EpubCorpusCase {
  readonly id: string;
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly expectPublication?: boolean;
  readonly expectedDiagnosticCodes?: readonly string[];
  readonly expectedCompatibilityStatus?: CompatibilityStatus;
  readonly archiveLimits?: Partial<OcfZipLimits>;
}

export interface EpubCorpusCaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly publicationOpened: boolean;
  readonly diagnostics: readonly PublicationDiagnostic[];
  readonly compatibilityStatus: CompatibilityStatus;
  readonly failures: readonly string[];
}

/** Deterministic parser/resource-front-door corpus runner used by CI fixtures. */
export async function runEpubCorpusCase(
  test: EpubCorpusCase,
): Promise<EpubCorpusCaseResult> {
  const loaded = await loadEpub(test.bytes, {
    archiveLimits: test.archiveLimits,
  });
  const compatibility = createCompatibilityReport(loaded.diagnostics);
  const failures: string[] = [];
  const opened = loaded.publication != null;

  if (test.expectPublication != null && opened !== test.expectPublication) {
    failures.push(
      `expected publicationOpened=${test.expectPublication}, got ${opened}`,
    );
  }
  for (const code of test.expectedDiagnosticCodes ?? []) {
    if (!loaded.diagnostics.some((diagnostic) => diagnostic.code === code)) {
      failures.push(`expected diagnostic ${code}`);
    }
  }
  if (
    test.expectedCompatibilityStatus &&
    compatibility.status !== test.expectedCompatibilityStatus
  ) {
    failures.push(
      `expected compatibility=${test.expectedCompatibilityStatus}, got ${compatibility.status}`,
    );
  }

  return Object.freeze({
    id: test.id,
    passed: failures.length === 0,
    publicationOpened: opened,
    diagnostics: loaded.diagnostics,
    compatibilityStatus: compatibility.status,
    failures: Object.freeze(failures),
  });
}

export async function runEpubCorpus(
  cases: readonly EpubCorpusCase[],
): Promise<readonly EpubCorpusCaseResult[]> {
  const results: EpubCorpusCaseResult[] = [];
  for (const test of cases) results.push(await runEpubCorpusCase(test));
  return Object.freeze(results);
}
