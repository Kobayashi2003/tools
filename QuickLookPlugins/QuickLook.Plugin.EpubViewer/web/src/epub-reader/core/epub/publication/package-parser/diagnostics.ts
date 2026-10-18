import type { PublicationDiagnostic, PublicationPath } from '../model';

export function packageDiagnostic(
  code: string,
  severity: PublicationDiagnostic['severity'],
  message: string,
  path: PublicationPath,
): PublicationDiagnostic {
  return { code, severity, phase: 'package', message, path };
}
