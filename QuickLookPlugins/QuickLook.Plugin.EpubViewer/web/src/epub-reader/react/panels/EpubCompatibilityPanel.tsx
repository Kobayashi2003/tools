import { useOptionalEpubReaderContext } from '../reader/context';
import type { EpubReaderHandle } from '../state/model';
import { DiagnosticGroups } from './compatibility/CompatibilityReport';
import {
  compatibilityHeadline,
  groupDiagnostics,
  groupRepairs,
  statusLabel,
} from './compatibility/report-model';

export function EpubCompatibilityPanel({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubCompatibilityPanel> requires a reader prop or EpubReaderProvider.',
    );

  const snapshot = reader.state.reader;
  if (!snapshot) {
    const groups = groupDiagnostics(reader.state.diagnostics);
    return (
      <section
        className="epub-reader-panel epub-compatibility-panel"
        aria-label="EPUB compatibility"
      >
        {groups.length > 0 ? (
          <>
            <header className="epub-compatibility-panel__summary">
              <span className="epub-compatibility-badge is-blocked">
                Blocked
              </span>
              <strong>This publication could not be opened.</strong>
              <span>
                {groups.length} diagnostic group{groups.length === 1 ? '' : 's'}
              </span>
            </header>
            <DiagnosticGroups groups={groups} open />
          </>
        ) : (
          <p className="epub-reader-panel__empty">
            No publication diagnostics are available.
          </p>
        )}
      </section>
    );
  }
  const report = snapshot.compatibility;
  const metadata = snapshot.publication.metadata;
  const groups = groupDiagnostics(snapshot.diagnostics);
  const repairs = groupRepairs(report.repairs);

  return (
    <section
      className="epub-reader-panel epub-compatibility-panel"
      aria-label="EPUB compatibility"
    >
      <header className="epub-compatibility-panel__summary">
        <span className={`epub-compatibility-badge is-${report.status}`}>
          {statusLabel(report.status)}
        </span>
        <strong>{compatibilityHeadline(report.status)}</strong>
        <span>
          {report.repairs.length} repairs · {report.warnings.length} warnings ·{' '}
          {report.unresolved.length} unresolved
        </span>
      </header>

      <dl className="epub-book-information">
        {metadata.creators.length > 0 ? (
          <div>
            <dt>Author</dt>
            <dd>
              {metadata.creators.map((creator) => creator.name).join(', ')}
            </dd>
          </div>
        ) : null}
        {metadata.publisher ? (
          <div>
            <dt>Publisher</dt>
            <dd>{metadata.publisher}</dd>
          </div>
        ) : null}
        {metadata.language ? (
          <div>
            <dt>Language</dt>
            <dd>{metadata.language}</dd>
          </div>
        ) : null}
        <div>
          <dt>Format</dt>
          <dd>
            EPUB {snapshot.publication.version} ·{' '}
            {snapshot.publication.spine.length} sections
          </dd>
        </div>
      </dl>

      {report.repairs.length > 0 ? (
        <details className="epub-compatibility-panel__details">
          <summary>
            Applied repairs <span>{repairs.length}</span>
          </summary>
          <ol>
            {repairs.map((repair) => (
              <li key={repair.strategy}>
                <strong>{repair.strategy}</strong>
                <span>
                  {repair.description}
                  {repair.count > 1 ? ` Applied ${repair.count} times.` : ''}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {groups.length > 0 ? <DiagnosticGroups groups={groups} /> : null}
    </section>
  );
}
