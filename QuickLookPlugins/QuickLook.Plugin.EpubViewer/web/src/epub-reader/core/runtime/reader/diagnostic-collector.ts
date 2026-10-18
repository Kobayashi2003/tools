import type { PublicationDiagnostic } from '../../epub/publication';
import { createCompatibilityReport } from '../../epub/compatibility/report';
import type { CompatibilityReport } from '../../epub/compatibility/model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

const EMPTY_DIAGNOSTICS: readonly PublicationDiagnostic[] =
  cloneAndFreezePlainData([]);

/** Publication-scoped diagnostic log that suppresses repeat renderer reports. */
export class PublicationDiagnosticCollector {
  private readonly keys = new Set<string>();
  private readonly diagnostics: PublicationDiagnostic[] = [];
  private snapshotValue: readonly PublicationDiagnostic[] = EMPTY_DIAGNOSTICS;
  private compatibilityValue: CompatibilityReport = cloneAndFreezePlainData(
    createCompatibilityReport(this.snapshotValue),
  );

  constructor(initial: readonly PublicationDiagnostic[] = []) {
    this.append(initial);
  }

  get all(): readonly PublicationDiagnostic[] {
    return this.snapshotValue;
  }

  get compatibility(): CompatibilityReport {
    return this.compatibilityValue;
  }

  append(
    next: readonly PublicationDiagnostic[],
  ): readonly PublicationDiagnostic[] {
    const unique = next.filter((diagnostic) => {
      const key = diagnosticKey(diagnostic);
      if (this.keys.has(key)) return false;
      this.keys.add(key);
      return true;
    });
    if (unique.length === 0) return EMPTY_DIAGNOSTICS;
    const stored = cloneAndFreezePlainData(unique);
    this.diagnostics.push(...stored);
    this.snapshotValue = cloneAndFreezePlainData([...this.diagnostics]);
    this.compatibilityValue = cloneAndFreezePlainData(
      createCompatibilityReport(this.snapshotValue),
    );
    return stored;
  }
}

function diagnosticKey(diagnostic: PublicationDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.phase,
    diagnostic.message,
    diagnostic.path ?? null,
    diagnostic.spineIndex ?? null,
    diagnostic.repair?.strategy ?? null,
  ]);
}
