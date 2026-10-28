import { useRef } from "react";
import type {
  StopEventBoardCoverage,
  TransitLine,
  PtMode,
  TransitNetwork,
} from "../data/transit-types";
import { navigateTo, routePaths } from "../routing";
import { LineBadge } from "./LineBadge";
import { ObservationEmptyState } from "./ObservationEmptyState";
import { getGroupedLines } from "../lib/line-families";
import { LineTermini, getLineTerminiLabel } from "./LineTermini";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";
import { useNetworkBandNavigation } from "../hooks/network-band-navigation";
import { network as networkDefinition } from "../networks/network";

/** Group order: trams, Stadtbahn, trains, then buses. */
const NETWORK_GROUP_ORDER: readonly PtMode[] = [
  "tram",
  "lightRail",
  "regionalRail",
  "longDistanceRail",
  "bus",
  "other",
];

const networkGroupLabels: Record<PtMode, string> = {
  tram: "Straßenbahn",
  bus: "Bus",
  lightRail: "Stadtbahn",
  regionalRail: "Regionalzüge",
  longDistanceRail: "Fernzüge",
  other: "Weitere Linien",
};

/** The lines of one mode, in the order the whole list already carries. */
type NetworkLineGroup = { ptMode: PtMode; lines: readonly TransitLine[] };

function groupLinesByPtMode(lines: readonly TransitLine[]): readonly NetworkLineGroup[] {
  const linesByMode = new Map<PtMode, TransitLine[]>();
  for (const line of lines) {
    const mode = line.ptMode ?? "other";
    const groupLines = linesByMode.get(mode) ?? [];
    groupLines.push(line);
    linesByMode.set(mode, groupLines);
  }
  return NETWORK_GROUP_ORDER.filter((mode) => linesByMode.has(mode)).map((ptMode) => ({
    ptMode,
    lines: linesByMode.get(ptMode)!,
  }));
}

/** What the view says while the observation has not named a line yet, or has stopped answering. */
const networkEmptyLabels = {
  loading: "Linien werden geladen …",
  unavailable: "Linien derzeit nicht abrufbar",
  empty: "Derzeit keine Linien beobachtet",
};

export function NetworkView({
  network,
  coverage,
  isStacked,
}: {
  network: TransitNetwork;
  coverage: StopEventBoardCoverage;
  isStacked: boolean;
}) {
  const groups = groupLinesByPtMode(getGroupedLines(network.lines));
  // The mode bands as navigation, not a filter.
  const linesRef = useRef<HTMLDivElement>(null);
  const { activeBandId, getBandRef, scrollToBand } = useNetworkBandNavigation(linesRef, {
    isEnabled: groups.length > 1,
    isPageScrollport: isStacked,
  });
  const bandItems = groups.map((group) => ({
    value: group.ptMode,
    label: networkGroupLabels[group.ptMode],
  })) satisfies readonly SegmentedControlItem<PtMode>[];

  return (
    <div className="network-view">
      <div className="panel-heading">
        <div>
          <h1>Linien in {networkDefinition.home.placeName}</h1>
        </div>
      </div>
      {groups.length > 1 && (
        <SegmentedControl
          className="network-band-navigation"
          isNavigation
          value={activeBandId ?? groups[0].ptMode}
          items={bandItems}
          ariaLabel="Verkehrsmittel"
          onValueChange={scrollToBand}
        />
      )}
      {groups.length === 0 ? (
        <ObservationEmptyState coverage={coverage} labels={networkEmptyLabels} />
      ) : (
        <div className="network-lines" ref={linesRef}>
          {groups.map((group) => (
            <section
              className="network-line-group"
              key={group.ptMode}
              ref={getBandRef(group.ptMode)}
            >
              {/* The count shows the group is the whole mode. */}
              <h2 className="network-group-heading">
                <span>{networkGroupLabels[group.ptMode]}</span>
                <small>{group.lines.length}</small>
              </h2>
              <div className="network-group-lines">
                {group.lines.map((line) => (
                  <button
                    key={line.id}
                    type="button"
                    onClick={() => navigateTo(routePaths.line(line.id))}
                    aria-label={`${getLineTerminiLabel(line)}. Linienverlauf öffnen`}
                  >
                    <LineBadge line={line} />
                    <LineTermini line={line} className="network-termini" />
                    <b aria-hidden="true">›</b>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
