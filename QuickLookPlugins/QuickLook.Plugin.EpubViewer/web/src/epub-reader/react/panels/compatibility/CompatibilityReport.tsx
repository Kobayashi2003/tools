import type { DiagnosticGroup } from './report-model';

export function DiagnosticGroups({
  groups,
  open = false,
}: {
  readonly groups: readonly DiagnosticGroup[];
  readonly open?: boolean;
}) {
  return (
    <details className="epub-compatibility-panel__details" open={open}>
      <summary>
        Technical diagnostics <span>{groups.length}</span>
      </summary>
      <ol>
        {groups.map((group) => (
          <li key={group.code}>
            <span className="epub-compatibility-panel__diagnostic-head">
              <code>{group.code}</code>
              <span>
                {group.count > 1 ? `×${group.count}` : group.severity}
              </span>
            </span>
            <span>{group.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
