import type { Bookmark } from '../../features/annotations';
import type { ReaderEvent } from './model';

/** Emit success feedback only after locator capture produced a bookmark. */
export async function addBookmarkAndNotify(
  addBookmark: (label?: string) => Promise<Bookmark | null>,
  label: string | undefined,
  onEvent?: (event: ReaderEvent) => void,
): Promise<Bookmark | null> {
  const bookmark = await addBookmark(label);
  if (bookmark) onEvent?.({ type: 'bookmark-added' });
  return bookmark;
}
