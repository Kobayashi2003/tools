import type { TocItem } from '../../../core';

export function collectBranchIds(
  items: readonly TocItem[],
  path = 'toc',
): readonly string[] {
  return items.flatMap((item, index) => {
    const id = item.id ?? `${path}:${index}:${item.label}`;
    return item.children.length > 0
      ? [id, ...collectBranchIds(item.children, id)]
      : [];
  });
}
