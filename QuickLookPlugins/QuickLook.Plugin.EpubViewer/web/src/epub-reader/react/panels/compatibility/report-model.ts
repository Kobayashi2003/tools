import type {
  AppliedCompatibilityRepair,
  CompatibilityStatus,
  PublicationDiagnostic,
} from '../../../core';

export interface DiagnosticGroup {
  readonly code: string;
  readonly count: number;
  readonly message: string;
  readonly severity: string;
}

export interface RepairGroup {
  readonly strategy: string;
  readonly count: number;
  readonly description: string;
}

export function groupRepairs(
  repairs: readonly AppliedCompatibilityRepair[],
): readonly RepairGroup[] {
  const groups = new Map<string, RepairGroup>();
  for (const repair of repairs) {
    const current = groups.get(repair.strategy);
    groups.set(
      repair.strategy,
      current
        ? { ...current, count: current.count + 1 }
        : {
            strategy: repair.strategy,
            count: 1,
            description: repair.description,
          },
    );
  }
  return [...groups.values()];
}

export function groupDiagnostics(
  diagnostics: readonly PublicationDiagnostic[],
): readonly DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  for (const diagnostic of diagnostics) {
    const current = groups.get(diagnostic.code);
    groups.set(
      diagnostic.code,
      current
        ? { ...current, count: current.count + 1 }
        : {
            code: diagnostic.code,
            count: 1,
            message: diagnostic.message,
            severity: diagnostic.severity,
          },
    );
  }
  return [...groups.values()].sort(
    (left, right) => severityRank(right.severity) - severityRank(left.severity),
  );
}

export function statusLabel(status: CompatibilityStatus): string {
  return status === 'clean'
    ? 'Clean'
    : status === 'repaired'
      ? 'Repaired'
      : status === 'degraded'
        ? 'Degraded'
        : 'Blocked';
}

export function compatibilityHeadline(status: CompatibilityStatus): string {
  if (status === 'clean')
    return 'This publication follows the supported profile.';
  if (status === 'repaired')
    return 'Compatibility repairs were applied safely.';
  if (status === 'degraded')
    return 'Some publication features could not be recovered.';
  return 'The publication cannot be opened safely.';
}

function severityRank(severity: string): number {
  return severity === 'fatal'
    ? 4
    : severity === 'error'
      ? 3
      : severity === 'warning'
        ? 2
        : 1;
}
