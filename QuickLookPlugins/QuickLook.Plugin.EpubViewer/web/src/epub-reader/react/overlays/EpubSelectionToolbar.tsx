import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type { AnnotationColor, ReaderSelectionActivation } from '../../core';
import { QUICK_ANNOTATION_COLORS as COLORS } from './annotation-colors';
import type { EpubReaderHandle } from '../state/model';

interface EpubSelectionToolbarProps {
  readonly activation: ReaderSelectionActivation;
  readonly reader: EpubReaderHandle;
  readonly onDismiss: (restoreFocus?: boolean) => void;
  readonly onSaved: (kind: 'highlight' | 'annotation') => void;
  readonly onModeChange: (mode: 'toolbar' | 'dialog') => void;
}

export function EpubSelectionToolbarContent({
  activation,
  reader,
  onDismiss,
  onSaved,
  onModeChange,
}: EpubSelectionToolbarProps) {
  const [color, setColor] = useState<AnnotationColor>('yellow');
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) textareaRef.current?.focus({ preventScroll: true });
    else if (activation.focusToolbar)
      primaryRef.current?.focus({ preventScroll: true });
  }, [activation.focusToolbar, editing]);

  const excerpt = selectionLabel(activation.selection.text);
  const setEditingMode = (next: boolean) => {
    setEditing(next);
    onModeChange(next ? 'dialog' : 'toolbar');
  };
  const saveHighlight = () => {
    reader.marks.addHighlight(
      activation.selection.range,
      'solid',
      color,
      excerpt,
    );
    onSaved('highlight');
    onDismiss(true);
  };
  const saveAnnotation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = body.trim();
    if (!value) return;
    reader.marks.addAnnotation(
      activation.selection.range,
      value,
      'solid',
      color,
      excerpt,
    );
    onSaved('annotation');
    onDismiss(true);
  };

  return editing ? (
    <form onSubmit={saveAnnotation}>
      <textarea
        ref={textareaRef}
        value={body}
        maxLength={2_000}
        rows={3}
        placeholder="Write a note"
        aria-label="Note text"
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          setBody(event.currentTarget.value)
        }
      />
      <div className="epub-reader-selection-tool__form-actions">
        <button
          type="button"
          onClick={() => {
            setEditingMode(false);
            setBody('');
          }}
        >
          Cancel
        </button>
        <button type="submit" disabled={!body.trim()}>
          Save note
        </button>
      </div>
    </form>
  ) : (
    <>
      <div
        className="epub-reader-selection-tool__colors"
        role="group"
        aria-label="Highlight color"
      >
        {COLORS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={`is-${candidate}`}
            aria-label={`${capitalize(candidate)} highlight`}
            aria-pressed={color === candidate}
            onClick={() => setColor(candidate)}
          />
        ))}
      </div>
      <span
        className="epub-reader-selection-tool__divider"
        aria-hidden="true"
      />
      <button ref={primaryRef} type="button" onClick={saveHighlight}>
        Highlight
      </button>
      <button type="button" onClick={() => setEditingMode(true)}>
        Add note
      </button>
      <button
        className="epub-reader-selection-tool__close"
        type="button"
        aria-label="Dismiss selection actions"
        onClick={() => onDismiss(true)}
      >
        ×
      </button>
    </>
  );
}

function selectionLabel(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > 90
    ? `${normalized.slice(0, 89).trimEnd()}…`
    : normalized;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
