import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GeoBox } from "../lib/geo-map";
import { useDragPan } from "./drag-pan";
import { useElementBox } from "./element-box";
import { useWheelZoom } from "./wheel-zoom";

const ZOOM_FACTOR = 1.6;

/** How a map opens and how far it zooms, in its own units. */
export type ExperimentMapScale = {
  /** What the map opens on, fitted into the view; the view's middle is its middle. */
  opening: GeoBox;
  /** Pixels per unit the map stops zooming at. */
  maximumScale: number;
};

const isSameBox = (left: GeoBox, right: GeoBox): boolean =>
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

/** An experiment map's drawn scale and scrollport. */
export type ExperimentMapCanvas = {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Pixels per map unit; `undefined` until measured. */
  scale: number | undefined;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** How far in from the whole map, as a share; 1 is the whole map. */
  zoom: number;
  changeZoom: (direction: 1 | -1) => void;
  onScroll: () => void;
};

/**
 * The map drawn at a scale, panned by scrolling or dragging. It opens on the city around `openOn`;
 * the zoom buttons or a growing map keep the middle of the view where it was, and the wheel keeps
 * the point under the pointer.
 */
export function useExperimentMapCanvas(
  bounds: GeoBox,
  openOn: { x: number; y: number },
  { opening, maximumScale }: ExperimentMapScale,
): ExperimentMapCanvas {
  const scrollRef = useRef<HTMLDivElement>(null);
  const box = useElementBox(scrollRef);
  useDragPan(scrollRef);
  const fitScale = box ? Math.min(box.width / bounds.width, box.height / bounds.height) : undefined;
  const [requestedScale, setRequestedScale] = useState<number>();
  const openingScale = box
    ? Math.min(box.width / opening.width, box.height / opening.height)
    : undefined;
  const clampScale = (next: number, fit: number) => Math.min(Math.max(next, fit), maximumScale);
  const scale =
    fitScale === undefined
      ? undefined
      : clampScale(requestedScale ?? openingScale ?? fitScale, fitScale);
  /** The view's middle, in map units. */
  const center = useRef(openOn);
  const drawn = useRef<{ scale: number; bounds: GeoBox } | null>(null);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || scale === undefined) return;
    const previous = drawn.current;
    if (previous && previous.scale === scale && isSameBox(previous.bounds, bounds)) return;
    drawn.current = { scale, bounds };
    element.scrollLeft = (center.current.x - bounds.x) * scale - element.clientWidth / 2;
    element.scrollTop = (center.current.y - bounds.y) * scale - element.clientHeight / 2;
  }, [scale, bounds]);

  const readCenter = () => {
    const element = scrollRef.current;
    const current = drawn.current;
    if (!element || !current) return;
    center.current = {
      x: current.bounds.x + (element.scrollLeft + element.clientWidth / 2) / current.scale,
      y: current.bounds.y + (element.scrollTop + element.clientHeight / 2) / current.scale,
    };
  };

  useWheelZoom(scrollRef, (factor, point) => {
    const element = scrollRef.current;
    const current = drawn.current;
    if (!element || !current || fitScale === undefined) return;
    const next = clampScale(current.scale * factor, fitScale);
    if (next === current.scale) return;
    // The map point under the pointer, kept under it at the new scale.
    const x = current.bounds.x + (element.scrollLeft + point.left) / current.scale;
    const y = current.bounds.y + (element.scrollTop + point.top) / current.scale;
    center.current = {
      x: x + (element.clientWidth / 2 - point.left) / next,
      y: y + (element.clientHeight / 2 - point.top) / next,
    };
    setRequestedScale(next);
  });

  return {
    scrollRef,
    scale,
    zoom: scale !== undefined && fitScale ? scale / fitScale : 1,
    canZoomIn: scale !== undefined && scale < maximumScale,
    canZoomOut: scale !== undefined && fitScale !== undefined && scale > fitScale,
    changeZoom: (direction) => {
      if (scale === undefined) return;
      readCenter();
      setRequestedScale(direction === 1 ? scale * ZOOM_FACTOR : scale / ZOOM_FACTOR);
    },
    onScroll: readCenter,
  };
}
