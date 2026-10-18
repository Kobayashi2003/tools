import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useOptionalEpubReaderContext } from '../reader/context';
import type { EpubReaderHandle } from '../state/model';
import { groupSearchHitsByChapter } from './panel-model';

export function EpubSearchPanel({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubSearchPanel> requires a reader prop or EpubReaderProvider.',
    );
  const state = reader.state.reader?.search;
  const publication = reader.state.reader?.publication;
  const readerReady = reader.state.reader != null;
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () =>
      groupSearchHitsByChapter(
        state?.hits ?? [],
        publication?.navigation.toc ?? [],
      ),
    [publication?.navigation.toc, state?.hits],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!readerReady) return;
    void reader.search.run(query);
  };

  return (
    <section
      className="epub-reader-panel epub-search-panel"
      aria-label="Find in book"
    >
      <form className="epub-search-panel__form" onSubmit={submit}>
        <input
          type="search"
          value={query}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setQuery(event.currentTarget.value)
          }
          placeholder="Find in book"
          aria-label="Find in book"
        />
        <div className="epub-search-panel__form-actions">
          <button
            type="submit"
            disabled={!readerReady || !query.trim() || state?.searching}
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              reader.search.clear();
            }}
          >
            Clear
          </button>
        </div>
      </form>
      {state?.searching ? <p role="status">Searching…</p> : null}
      {state?.error && !state.searching ? (
        <p className="epub-search-panel__summary" role="alert">
          Search could not be completed.
        </p>
      ) : null}
      {state && !state.searching && state.query && !state.error ? (
        <p
          className="epub-search-panel__summary"
          role="status"
          aria-live="polite"
        >
          {state.hits.length === 0
            ? 'No results found.'
            : state.truncated
              ? `Showing the first ${state.hits.length} results.`
              : `${state.hits.length} result${state.hits.length === 1 ? '' : 's'} found.`}
        </p>
      ) : null}
      {state && !state.searching && state.diagnostics.length > 0 ? (
        <p className="epub-search-panel__summary">
          Some sections required compatibility recovery or could not be
          searched.
        </p>
      ) : null}
      {state && state.hits.length > 0 ? (
        <>
          <div className="epub-search-panel__pager">
            <button
              type="button"
              aria-label="Previous search result"
              onClick={() => void reader.search.previous()}
            >
              Previous
            </button>
            <span>
              {state.index >= 0 ? state.index + 1 : '–'} / {state.hits.length}
            </span>
            <button
              type="button"
              aria-label="Next search result"
              onClick={() => void reader.search.next()}
            >
              Next
            </button>
          </div>
          <div
            className="epub-search-panel__groups"
            aria-label="Search results"
          >
            {groups.map((group) => (
              <section
                key={group.key}
                className="epub-search-panel__group"
                aria-label={`${group.chapter.label} search results`}
              >
                <header>
                  <div>
                    <strong>{group.chapter.label}</strong>
                    {group.chapter.path.length > 1 ? (
                      <span>{group.chapter.path.slice(0, -1).join(' / ')}</span>
                    ) : null}
                  </div>
                  <small>{group.results.length}</small>
                </header>
                <ol className="epub-search-panel__results">
                  {group.results.map(({ hit, index }) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        aria-current={
                          index === state.index ? 'true' : undefined
                        }
                        onClick={() => void reader.search.goTo(index)}
                      >
                        <span className="epub-search-result__context">
                          <small>
                            Result {index + 1} · section {hit.spineIndex + 1}
                          </small>
                        </span>
                        <span className="epub-search-result__excerpt">
                          {highlightMatch(
                            hit.excerpt,
                            hit.excerptMatchStart,
                            hit.excerptMatchEnd,
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function highlightMatch(excerpt: string, start: number, end: number) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > excerpt.length
  )
    return excerpt;
  return (
    <>
      {excerpt.slice(0, start)}
      <mark>{excerpt.slice(start, end)}</mark>
      {excerpt.slice(end)}
    </>
  );
}
