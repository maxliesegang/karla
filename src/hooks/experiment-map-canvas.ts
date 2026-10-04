import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GeoBox } from "../lib/geo-map";
import { useElementBox } from "./element-box";

const ZOOM_FACTOR = 1.6;

/** How a map opens and how far it zooms, in its own units. */
export type ExperimentMapScale = {
  /** The span the shorter side of the box opens on. */
  openingSpan: number;
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
 * The map drawn at a scale, panned by scrolling. It opens on the city around `openOn`; zooming or a
 * growing map keeps the middle of the view where it was.
 */
export function useExperimentMapCanvas(
  bounds: GeoBox,
  openOn: { x: number; y: number },
  { openingSpan, maximumScale }: ExperimentMapScale,
): ExperimentMapCanvas {
  const scrollRef = useRef<HTMLDivElement>(null);
  const box = useElementBox(scrollRef);
  const fitScale = box ? Math.min(box.width / bounds.width, box.height / bounds.height) : undefined;
  const [requestedScale, setRequestedScale] = useState<number>();
  const openingScale = box ? Math.min(box.width, box.height) / openingSpan : undefined;
  const scale =
    fitScale === undefined
      ? undefined
      : Math.min(Math.max(requestedScale ?? openingScale ?? fitScale, fitScale), maximumScale);
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
