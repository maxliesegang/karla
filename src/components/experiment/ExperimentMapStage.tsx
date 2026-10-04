import type { ComponentProps, ReactNode } from "react";
import { type ExperimentMapScale, useExperimentMapCanvas } from "../../hooks/experiment-map-canvas";
import type { ExperimentMap } from "../../routing";
import { ZentrumPlanControls } from "../zentrum/ZentrumSchematicToolbar";
import { ExperimentMapCanvas } from "./ExperimentMapCanvas";
import { ExperimentMapSwitch } from "./ExperimentMapSwitch";

/** A map's scrollport and its floating controls; mounted once there is a map to measure. */
export function ExperimentMapStage({
  map,
  canvas: canvasProps,
  openOn,
  scale,
  isFullscreen,
  onChangeFullscreen,
  options,
}: {
  map: ExperimentMap;
  canvas: Omit<ComponentProps<typeof ExperimentMapCanvas>, "scale" | "scrollRef" | "onScroll">;
  /** Where the view opens, in map units. */
  openOn: { x: number; y: number };
  scale: ExperimentMapScale;
  isFullscreen: boolean;
  onChangeFullscreen: (isFullscreen: boolean) => void;
  /** Choices for how this map draws, floating in its top corner. */
  options?: ReactNode;
}) {
  const canvas = useExperimentMapCanvas(canvasProps.bounds, openOn, scale);
  return (
    <div className="zentrum-schematic-stage">
      <ExperimentMapCanvas
        {...canvasProps}
        scale={canvas.scale}
        scrollRef={canvas.scrollRef}
        onScroll={canvas.onScroll}
      />
      <ZentrumPlanControls
        zoom={canvas.zoom}
        canZoomIn={canvas.canZoomIn}
        canZoomOut={canvas.canZoomOut}
        onChangeZoom={canvas.changeZoom}
        isFullscreen={isFullscreen}
        onChangeFullscreen={onChangeFullscreen}
        wholeLabel="ganze Karte"
      />
      <ExperimentMapSwitch map={map} />
      {options && <div className="experiment-map-options">{options}</div>}
    </div>
  );
}
