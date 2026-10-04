import { type ExperimentMap, navigateTo, routePaths } from "../../routing";
import { SegmentedControl } from "../SegmentedControl";

const EXPERIMENT_MAPS = [
  { value: "center", label: "Zentrum" },
  { value: "region", label: "Region" },
  { value: "geo", label: "Karte" },
] as const;

/** Chooses the experiment page's map, floating in the drawing's bottom corner. */
export function ExperimentMapSwitch({ map }: { map: ExperimentMap }) {
  return (
    <SegmentedControl
      className="departure-board-order-control experiment-map-switch"
      value={map}
      items={EXPERIMENT_MAPS}
      onValueChange={(next) =>
        navigateTo(next === "center" ? routePaths.zentrum() : routePaths.map(next))
      }
      ariaLabel="Kartenform"
      isNavigation
    />
  );
}
