import { useEffect, useState } from 'react';
import { readerLayoutForWidth } from '../configuration/layout';

export function useCompactReaderLayout(
  target: { readonly current: HTMLElement | null },
  compactBreakpointPx: number,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const update = () =>
      setCompact(
        readerLayoutForWidth(
          element.getBoundingClientRect().width,
          compactBreakpointPx,
        ) === 'compact',
      );
    update();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compactBreakpointPx, target]);

  return compact;
}
