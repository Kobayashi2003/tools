import type { CSSProperties } from 'react';
import type { ReaderPreferences } from '../../../core';

interface TouchNavigationPreviewProps {
  readonly mode: ReaderPreferences['touchNavigation'];
  readonly zonePercent: number;
  readonly progression: ReaderPreferences['pageProgression'];
}

export function TouchNavigationPreview({
  mode,
  zonePercent,
  progression,
}: TouchNavigationPreviewProps) {
  const style = { '--touch-zone-width': `${zonePercent}%` } as CSSProperties;
  const tap = mode === 'both' || mode === 'tap';
  const swipe = mode === 'both' || mode === 'swipe';
  const modeLabel = {
    both: 'TAP + SWIPE',
    tap: 'TAP ZONES',
    swipe: 'SWIPE ONLY',
    off: 'OFF',
  }[mode];
  return (
    <div
      className={`epub-touch-preview${tap ? ' has-tap' : ''}${swipe ? ' has-swipe' : ''} is-${progression}`}
      style={style}
      aria-label={`${modeLabel.toLowerCase()} touch navigation preview`}
    >
      <span className="epub-touch-preview__mode">{modeLabel}</span>
      <span className="epub-touch-preview__zone is-left" aria-hidden="true" />
      <span className="epub-touch-preview__page" aria-hidden="true" />
      <span className="epub-touch-preview__zone is-right" aria-hidden="true" />
      {swipe ? (
        <span className="epub-touch-preview__swipe" aria-hidden="true">
          →
        </span>
      ) : null}
    </div>
  );
}

interface ComicLayoutPreviewProps {
  readonly fit: ReaderPreferences['fixedLayoutFit'];
  readonly gutter: ReaderPreferences['fixedLayoutGutter'];
  readonly spread: ReaderPreferences['spread'];
  readonly progression: ReaderPreferences['pageProgression'];
}

export function ComicLayoutPreview({
  fit,
  gutter,
  spread,
  progression,
}: ComicLayoutPreviewProps) {
  const fitLabel = {
    contain: 'WHOLE PAGE',
    width: 'FIT WIDTH',
    height: 'FIT HEIGHT',
    original: 'ORIGINAL 1:1',
  }[fit];
  const pages = progression === 'rtl' ? ['2', '1'] : ['1', '2'];
  return (
    <div
      className={`epub-comic-layout-preview is-${fit}${spread === 'single' ? ' is-single' : ''}${gutter === 'none' ? ' has-no-gutter' : ''}`}
      aria-label={`${fitLabel.toLowerCase()} comic page preview, ${gutter} gutter`}
    >
      <span className="epub-comic-layout-preview__mode">{fitLabel}</span>
      <div className="epub-comic-layout-preview__viewport" aria-hidden="true">
        <div className="epub-comic-layout-preview__pages">
          {pages.map((page) => (
            <span key={page} data-page={page}>
              <i />
              <i />
              <i />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface TextLayoutPreviewProps {
  readonly fontFamily: string | null;
  readonly fontSizePercent: number;
  readonly lineHeight: number | null;
  readonly marginPercent: number;
  readonly theme: string;
  readonly vertical: boolean;
}

export function TextLayoutPreview({
  fontFamily,
  fontSizePercent,
  lineHeight,
  marginPercent,
  theme,
  vertical,
}: TextLayoutPreviewProps) {
  const style = {
    '--preview-font-family': fontFamily ?? 'Georgia, serif',
    '--preview-font-scale': String(fontSizePercent / 100),
    '--preview-line-height': String(lineHeight ?? 1.55),
    '--preview-margin': `${marginPercent / 2}%`,
  } as CSSProperties;
  return (
    <div
      className={`epub-text-layout-preview is-${theme}${vertical ? ' is-vertical' : ''}`}
      style={style}
      aria-label={`${vertical ? 'Vertical' : 'Horizontal'} text layout preview`}
    >
      <span aria-hidden="true">
        {vertical ? '静かな読書の時間' : 'A quiet page for focused reading.'}
      </span>
    </div>
  );
}
