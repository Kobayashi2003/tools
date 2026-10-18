/** Pure layout decision shared by the responsive Hook and configuration tests. */
export function readerLayoutForWidth(
  width: number,
  compactBreakpointPx: number,
): 'compact' | 'wide' {
  return width <= compactBreakpointPx ? 'compact' : 'wide';
}
