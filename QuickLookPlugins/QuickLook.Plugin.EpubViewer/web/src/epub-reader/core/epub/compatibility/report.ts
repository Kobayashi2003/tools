import type { PublicationDiagnostic } from '../publication';
import type {
  AppliedCompatibilityRepair,
  CompatibilityReport,
  CompatibilityStatus,
} from './model';

/**
 * Convert the engine's explicit diagnostics into a stable compatibility summary.
 *
 * The report never invents a repair. Only diagnostics that carry a `repair`
 * object count as repaired behavior, keeping malformed-publication recovery
 * observable instead of silently normalizing the source.
 */
export function createCompatibilityReport(
  diagnostics: readonly PublicationDiagnostic[],
): CompatibilityReport {
  const repairs: AppliedCompatibilityRepair[] = [];
  const unresolved: PublicationDiagnostic[] = [];
  const warnings: PublicationDiagnostic[] = [];
  const infos: PublicationDiagnostic[] = [];
  const resolvedCodes = new Set(
    diagnostics.flatMap((diagnostic) => diagnostic.repair?.resolvesCodes ?? []),
  );

  for (const diagnostic of diagnostics) {
    if (diagnostic.repair) {
      repairs.push({
        code: diagnostic.code,
        strategy: diagnostic.repair.strategy,
        description: diagnostic.repair.description,
        ...(diagnostic.repair.confidence == null
          ? {}
          : { confidence: diagnostic.repair.confidence }),
        ...(diagnostic.repair.resolvesCodes == null
          ? {}
          : {
              resolvesCodes: Object.freeze([
                ...diagnostic.repair.resolvesCodes,
              ]),
            }),
        diagnostic,
      });
    }

    if (
      (diagnostic.severity === 'error' || diagnostic.severity === 'fatal') &&
      !diagnostic.repair &&
      !resolvedCodes.has(diagnostic.code)
    ) {
      unresolved.push(diagnostic);
    } else if (diagnostic.severity === 'warning') {
      warnings.push(diagnostic);
    } else if (diagnostic.severity === 'info') {
      infos.push(diagnostic);
    }
  }

  return Object.freeze({
    status: compatibilityStatus(diagnostics, repairs, unresolved),
    repairs: Object.freeze(repairs),
    unresolved: Object.freeze(unresolved),
    warnings: Object.freeze(warnings),
    infos: Object.freeze(infos),
  });
}

function compatibilityStatus(
  diagnostics: readonly PublicationDiagnostic[],
  repairs: readonly AppliedCompatibilityRepair[],
  unresolved: readonly PublicationDiagnostic[],
): CompatibilityStatus {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'fatal'))
    return 'blocked';
  if (unresolved.length > 0) return 'degraded';
  if (repairs.length > 0) return 'repaired';
  return 'clean';
}
