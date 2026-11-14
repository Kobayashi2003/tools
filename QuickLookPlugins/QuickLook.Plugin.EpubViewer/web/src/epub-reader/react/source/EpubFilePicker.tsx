import { useState, type ChangeEvent, type DragEvent } from 'react';

export interface EpubFilePickerProps {
  /** Receives a local EPUB or Kindle (AZW3) File. The picker never uploads it to a server. */
  readonly onFile: (file: File) => void;
  readonly currentFileName?: string | null;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
  readonly onRejected?: (file: File) => void;
}

/**
 * Local EPUB and Kindle (AZW3/KF8) file picker used by demos and host applications.
 *
 * It is intentionally independent from EpubReader/useEpubReader: selecting a
 * file only returns a File (Blob). The host decides when and where to open it.
 */
export function EpubFilePicker({
  onFile,
  currentFileName = null,
  disabled = false,
  compact = false,
  className,
  onRejected,
}: EpubFilePickerProps) {
  const [dragging, setDragging] = useState(false);

  const commit = (file: File | undefined) => {
    if (!file || disabled) return;
    if (!looksLikeBook(file)) {
      onRejected?.(file);
      return;
    }
    onFile(file);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    commit(event.currentTarget.files?.[0]);
    // Allow choosing the same file again after it has changed on disk.
    event.currentTarget.value = '';
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    commit(event.dataTransfer.files?.[0]);
  };

  return (
    <label
      className={[
        'epub-file-picker',
        compact ? 'epub-file-picker--compact' : '',
        dragging ? 'is-dragging' : '',
        disabled ? 'is-disabled' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragEnter={(event: DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event: DragEvent<HTMLLabelElement>) =>
        event.preventDefault()
      }
      onDragLeave={(event: DragEvent<HTMLLabelElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        className="epub-file-picker__input"
        type="file"
        accept={BOOK_ACCEPT}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="epub-file-picker__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 15V4m0 0L8 8m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
      </span>
      <span className="epub-file-picker__copy">
        <strong>
          {currentFileName
            ? compact
              ? 'Change book'
              : 'Choose another book'
            : 'Open a book'}
        </strong>
        {!compact ? (
          <small>Drop a local .epub or .azw3 here or choose a file</small>
        ) : null}
      </span>
    </label>
  );
}

const BOOK_ACCEPT =
  '.epub,application/epub+zip,.azw3,.azw,.mobi,application/vnd.amazon.ebook,application/x-mobipocket-ebook';

/** EPUB, or a Kindle file whose KF8 section the reader can open. */
function looksLikeBook(file: File): boolean {
  if (/\.(?:epub|azw3|azw|mobi)$/iu.test(file.name)) return true;
  return [
    'application/epub+zip',
    'application/vnd.amazon.ebook',
    'application/x-mobipocket-ebook',
  ].includes(file.type);
}
