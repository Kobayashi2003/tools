import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderFeedbackSpec } from '../../chrome/feedback-model';

export interface ReaderFeedbackController {
  readonly feedback: (ReaderFeedbackSpec & { readonly id: number }) | null;
  readonly show: (feedback: ReaderFeedbackSpec) => void;
}

export function useReaderFeedback(): ReaderFeedbackController {
  const [feedback, setFeedback] = useState<
    (ReaderFeedbackSpec & { readonly id: number }) | null
  >(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  const show = useCallback((next: ReaderFeedbackSpec) => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    setFeedback({ ...next, id: ++idRef.current });
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        setFeedback(null);
      },
      next.tone === 'boundary' ? 1500 : 1800,
    );
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  return { feedback, show };
}
