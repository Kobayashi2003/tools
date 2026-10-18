import { EpubExternalLinkBody } from '../overlays/EpubExternalLinkDialog';
import { EpubImageViewerContent } from '../overlays/EpubImageViewer';
import type { AnyReaderSurfaceRenderer } from './model';
import {
  BuiltInMarkSurface,
  BuiltInSelectionSurface,
} from './BuiltInInteractiveSurfaceContent';

export const BUILT_IN_READER_SURFACE_RENDERERS = Object.freeze([
  {
    kind: 'footnote',
    render: ({ surface }) => (
      <>
        {surface.footnote.paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </>
    ),
  },
  {
    kind: 'selection',
    render: (context) => <BuiltInSelectionSurface context={context} />,
  },
  {
    kind: 'mark',
    render: (context) => <BuiltInMarkSurface context={context} />,
  },
  {
    kind: 'image',
    render: ({ surface, close }) => (
      <EpubImageViewerContent activation={surface.activation} onClose={close} />
    ),
  },
  {
    kind: 'external-link',
    render: ({ surface }) => <EpubExternalLinkBody target={surface.target} />,
  },
] as const satisfies readonly AnyReaderSurfaceRenderer[]);
