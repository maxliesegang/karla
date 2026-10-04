import { useCallback, useEffect } from "react";
import type { ExperimentMapScale } from "../../hooks/experiment-map-canvas";
import type { DirectTravelTime } from "../../lib/direct-travel-times";
import type { GeoBox, MapDrawing } from "../../lib/geo-map";
import {
  navigateTo,
  type OtherExperimentMap,
  replaceCurrentRoute,
  routePaths,
} from "../../routing";
import type { ZentrumLineSignReader } from "../zentrum/line-sign";
import { ExperimentMapStage } from "./ExperimentMapStage";

/**
 * An experiment map with its band: a caption, and an opened stop's name and close. The address
 * drops a stop the drawing does not hold, once the drawing has answered.
 */
export function ExperimentMapPage({
  map,
  label,
  drawing,
  places = [],
  bounds,
  scale,
  homePoint,
  selectedStopId,
  times,
  feedNow,
  getSign,
  isAnswered,
  isFullscreen,
  overviewCaption,
  linesAtRest,
}: {
  map: OtherExperimentMap;
  /** The section's accessible name. */
  label: string;
  drawing: MapDrawing;
  places?: readonly { name: string; x: number; y: number }[];
  bounds: GeoBox;
  scale: ExperimentMapScale;
  /** Where the map opens without an opened stop. */
  homePoint: { x: number; y: number };
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  /** The opened stop's direct rides. */
  times?: ReadonlyMap<string, DirectTravelTime>;
  feedNow: number;
  getSign: ZentrumLineSignReader;
  isAnswered: boolean;
  isFullscreen: boolean;
  overviewCaption: string;
  linesAtRest?: boolean;
}) {
  const openedStop = selectedStopId ? drawing.stops.get(selectedStopId) : undefined;
  useEffect(() => {
    if (selectedStopId && !openedStop && isAnswered) {
      replaceCurrentRoute(routePaths.map(map, undefined, isFullscreen));
    }
  }, [map, selectedStopId, openedStop, isAnswered, isFullscreen]);
  const selectStop = useCallback(
    (stopId: string | undefined) => navigateTo(routePaths.map(map, stopId, isFullscreen)),
    [map, isFullscreen],
  );
  const changeFullscreen = useCallback(
    (next: boolean) => navigateTo(routePaths.map(map, openedStop?.id, next)),
    [map, openedStop],
  );
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, changeFullscreen]);

  const caption = !openedStop
    ? overviewCaption
    : times && times.size > 0
      ? "Minuten bis zur Ankunft, ohne Umsteigen"
      : "Gerade keine beobachtete Fahrt ab hier";

  return (
    <section className="zentrum-schematic" data-fullscreen={isFullscreen} aria-label={label}>
      <ExperimentMapStage
        map={map}
        scale={scale}
        openOn={openedStop ?? homePoint}
        isFullscreen={isFullscreen}
        onChangeFullscreen={changeFullscreen}
        canvas={{
          drawing,
          places,
          bounds,
          times,
          feedNow,
          selectedStopId: openedStop?.id,
          getSign,
          onSelectStop: selectStop,
          linesAtRest,
        }}
      />
      <div className="zentrum-schematic-toolbar" data-has-stop={openedStop !== undefined}>
        <p className="zentrum-schematic-caption">{caption}</p>
        {openedStop && (
          <div
            className="zentrum-stop-bar"
            role="group"
            aria-label={`Haltestelle ${openedStop.name}`}
          >
            <h2 key={openedStop.id}>{openedStop.name}</h2>
            <button
              type="button"
              className="zentrum-panel-close"
              aria-label={`${openedStop.name} schließen`}
              onClick={() => selectStop(undefined)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
