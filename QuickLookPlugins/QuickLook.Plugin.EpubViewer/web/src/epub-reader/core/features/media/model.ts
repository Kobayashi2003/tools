/** An HTML `<img>` or an SVG `<image>` that can open the image viewer. */
export type ReaderImageTrigger = HTMLElement | SVGElement;

export interface ReaderImageActivation {
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
  readonly intrinsicWidth?: number;
  readonly intrinsicHeight?: number;
  readonly trigger: ReaderImageTrigger;
}
