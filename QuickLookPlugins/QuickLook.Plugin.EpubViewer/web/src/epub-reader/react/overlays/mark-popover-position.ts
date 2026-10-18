export interface MarkPopoverPoint {
  readonly x: number;
  readonly y: number;
}

export interface MarkPopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface MarkPopoverPlacement {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
  readonly side: 'above' | 'below';
}

/** Keeps a variable-height mark editor inside the reader viewport. */
export function placeMarkPopover(
  anchor: MarkPopoverPoint,
  viewport: MarkPopoverSize,
  popover: MarkPopoverSize,
  margin = 12,
  gap = 10,
): MarkPopoverPlacement {
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const renderedHeight = Math.min(popover.height, maxHeight);
  const maximumLeft = Math.max(margin, viewport.width - margin - popover.width);
  const left = clamp(anchor.x - popover.width / 2, margin, maximumLeft);
  const below = anchor.y + gap;
  const above = anchor.y - gap - renderedHeight;
  const fitsBelow = below + renderedHeight <= viewport.height - margin;
  const fitsAbove = above >= margin;
  const side = fitsBelow || !fitsAbove ? 'below' : 'above';
  const preferredTop = side === 'below' ? below : above;
  const maximumTop = Math.max(
    margin,
    viewport.height - margin - renderedHeight,
  );

  return {
    left,
    top: clamp(preferredTop, margin, maximumTop),
    maxHeight,
    side,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
