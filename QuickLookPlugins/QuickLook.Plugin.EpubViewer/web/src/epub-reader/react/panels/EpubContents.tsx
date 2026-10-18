import { useEffect, useMemo, useRef, useState } from 'react';
import type { Publication } from '../../core';
import { useOptionalEpubReaderContext } from '../reader/context';
import type { EpubReaderHandle } from '../state/model';
import {
  publicationContentsKey,
  readCollapsedSections,
  writeCollapsedSections,
} from './contents/collapse-state';
import { HistoryGroup, NavigationEntries } from './contents/NavigationEntries';
import { landmarkLabel } from './contents/navigation-model';
import { TocItems } from './contents/TocItems';
import { collectBranchIds } from './contents/toc-model';
import { locatorHref, tocItemCount, tocItemForHref } from './panel-model';

type NavigationView = 'contents' | 'pages' | 'landmarks' | 'history';

export function EpubContents({
  reader: explicit,
}: {
  readonly reader?: EpubReaderHandle;
}) {
  const contextual = useOptionalEpubReaderContext();
  const reader = explicit ?? contextual;
  if (!reader)
    throw new Error(
      '<EpubContents> requires a reader prop or EpubReaderProvider.',
    );
  const snapshot = reader.state.reader;
  if (!snapshot) return null;
  const publicationKey = publicationContentsKey(snapshot.publication);
  return (
    <EpubContentsView
      key={publicationKey}
      reader={reader}
      publication={snapshot.publication}
      publicationKey={publicationKey}
    />
  );
}

interface EpubContentsViewProps {
  readonly reader: EpubReaderHandle;
  readonly publication: Publication;
  readonly publicationKey: string;
}

function EpubContentsView({
  reader,
  publication,
  publicationKey,
}: EpubContentsViewProps) {
  const snapshot = reader.state.reader!;
  const { toc, pageList, landmarks } = publication.navigation;
  const currentLocator = snapshot.locator;
  const currentHref = currentLocator ? locatorHref(currentLocator) : undefined;
  const activeItem = useMemo(
    () => tocItemForHref(toc, currentHref),
    [currentHref, toc],
  );
  const [view, setView] = useState<NavigationView>('contents');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    readCollapsedSections(publicationKey),
  );
  const activeLinkRef = useRef<HTMLButtonElement | null>(null);
  const branchIds = useMemo(() => collectBranchIds(toc), [toc]);
  const history = snapshot.navigationHistory;

  useEffect(() => {
    if (view === 'contents')
      activeLinkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeItem, view]);

  const updateCollapsed = (next: ReadonlySet<string>) => {
    setCollapsed(next);
    writeCollapsedSections(publicationKey, next);
  };
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateCollapsed(next);
  };

  // Page lists and landmarks are optional publication structures; an empty one
  // is a dead end, so its tab is omitted. History stays because it fills up.
  const tabs: readonly {
    readonly id: NavigationView;
    readonly label: string;
    readonly count: number;
  }[] = [
    { id: 'contents' as const, label: 'Contents', count: tocItemCount(toc) },
    { id: 'pages' as const, label: 'Pages', count: pageList.length },
    { id: 'landmarks' as const, label: 'Landmarks', count: landmarks.length },
    {
      id: 'history' as const,
      label: 'History',
      count: history.backCount + history.forwardCount,
    },
  ].filter(
    (tab) => (tab.id !== 'pages' && tab.id !== 'landmarks') || tab.count > 0,
  );

  return (
    <nav
      className="epub-reader-panel epub-contents"
      aria-label="Publication navigation"
    >
      <div
        className="epub-contents__tabs"
        role="tablist"
        aria-label="Publication navigation views"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            aria-controls={`epub-navigation-${tab.id}`}
            onClick={() => setView(tab.id)}
          >
            <span>{tab.label}</span>
            <small>{tab.count}</small>
          </button>
        ))}
      </div>

      {view === 'contents' ? (
        <section
          id="epub-navigation-contents"
          role="tabpanel"
          className="epub-contents__toc"
        >
          <div className="epub-contents__summary">
            <span>{tocItemCount(toc)} sections</span>
            {branchIds.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  updateCollapsed(
                    collapsed.size ? new Set() : new Set(branchIds),
                  )
                }
              >
                {collapsed.size ? 'Expand all' : 'Collapse all'}
              </button>
            ) : null}
          </div>
          {toc.length > 0 ? (
            <TocItems
              items={toc}
              reader={reader}
              activeItem={activeItem}
              collapsed={collapsed}
              onToggle={toggle}
              path="toc"
              activeLinkRef={activeLinkRef}
            />
          ) : (
            <p className="epub-reader-panel__empty">
              This publication does not provide a table of contents.
            </p>
          )}
        </section>
      ) : null}

      {view === 'pages' ? (
        <section id="epub-navigation-pages" role="tabpanel">
          <NavigationEntries
            entries={pageList}
            empty="This publication does not provide a page list."
            currentHref={currentHref}
            label={(item) => item.label}
            meta={() => 'Page'}
            onActivate={(item) =>
              void reader.goTo({ kind: 'href', href: item.href })
            }
          />
        </section>
      ) : null}

      {view === 'landmarks' ? (
        <section id="epub-navigation-landmarks" role="tabpanel">
          <NavigationEntries
            entries={landmarks}
            empty="This publication does not provide landmarks."
            currentHref={currentHref}
            label={(item) => item.label || landmarkLabel(item)}
            meta={(item) => item.types.join(' · ')}
            onActivate={(item) =>
              void reader.goTo({ kind: 'href', href: item.href })
            }
          />
        </section>
      ) : null}

      {view === 'history' ? (
        <section
          id="epub-navigation-history"
          role="tabpanel"
          className="epub-contents__history"
        >
          {history.back.length === 0 && history.forward.length === 0 ? (
            <p className="epub-reader-panel__empty">
              Locations opened from search, marks, and publication navigation
              will appear here.
            </p>
          ) : (
            <>
              <HistoryGroup
                direction="back"
                label="Previous locations"
                locations={[...history.back].reverse()}
                toc={toc}
                reader={reader}
              />
              <HistoryGroup
                direction="forward"
                label="Forward locations"
                locations={[...history.forward].reverse()}
                toc={toc}
                reader={reader}
              />
            </>
          )}
        </section>
      ) : null}
    </nav>
  );
}
