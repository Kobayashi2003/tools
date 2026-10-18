import type { RefObject } from 'react';
import type { TocItem } from '../../../core';
import type { EpubReaderHandle } from '../../state/model';

interface TocItemsProps {
  readonly items: readonly TocItem[];
  readonly reader: EpubReaderHandle;
  readonly activeItem: TocItem | null;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly path: string;
  readonly activeLinkRef: RefObject<HTMLButtonElement | null>;
}

export function TocItems({
  items,
  reader,
  activeItem,
  collapsed,
  onToggle,
  path,
  activeLinkRef,
}: TocItemsProps) {
  return (
    <ol>
      {items.map((item, index) => {
        const id = item.id ?? `${path}:${index}:${item.label}`;
        const active = item === activeItem;
        const activeBranch = active || containsItem(item.children, activeItem);
        const isCollapsed = collapsed.has(id) && !activeBranch;

        return (
          <li
            key={id}
            className={activeBranch ? 'is-current-branch' : undefined}
          >
            <div className="epub-contents__item">
              {item.children.length > 0 ? (
                <button
                  className="epub-contents__disclosure"
                  type="button"
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${item.label}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => onToggle(id)}
                >
                  <span aria-hidden="true">›</span>
                </button>
              ) : (
                <span className="epub-contents__leaf" aria-hidden="true" />
              )}
              {item.href ? (
                <button
                  ref={active ? activeLinkRef : undefined}
                  className="epub-contents__link"
                  type="button"
                  aria-current={active ? 'location' : undefined}
                  onClick={() =>
                    void reader.goTo({ kind: 'href', href: item.href! })
                  }
                >
                  {item.label}
                </button>
              ) : (
                <span className="epub-contents__label">{item.label}</span>
              )}
            </div>
            {item.children.length > 0 && !isCollapsed ? (
              <TocItems
                items={item.children}
                reader={reader}
                activeItem={activeItem}
                collapsed={collapsed}
                onToggle={onToggle}
                path={id}
                activeLinkRef={activeLinkRef}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function containsItem(
  items: readonly TocItem[],
  target: TocItem | null,
): boolean {
  return (
    target != null &&
    items.some((item) => item === target || containsItem(item.children, target))
  );
}
