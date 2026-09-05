import { useRef } from "react";
import type {
  DepartureBoardCoverage,
  TransitLine,
  TransportMode,
  TransitNetwork,
} from "../data/transit-types";
import { navigateTo, routePaths } from "../routing";
import { LineBadge } from "./LineBadge";
import { ObservationEmptyState } from "./ObservationEmptyState";
import { getGroupedLines } from "../lib/line-families";
import { LineTermini, getLineTerminiLabel } from "./LineTermini";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";
import { useNetworkBandNav } from "../hooks";

/**
 * The list a rider scans, one heading per mode: the rail modes together first — the trams of the
 * city, then the Stadtbahn that runs out of it — and the buses after them.
 */
const NETWORK_GROUP_ORDER: readonly TransportMode[] = ["tram", "lightRail", "bus", "other"];

const networkGroupLabels: Record<TransportMode, string> = {
  tram: "Straßenbahn",
  bus: "Bus",
  lightRail: "Stadtbahn",
  other: "Weitere Linien",
};

/** The lines of one mode, in the order the whole list already carries. */
type NetworkLineGroup = { transportMode: TransportMode; lines: readonly TransitLine[] };

function groupLinesByTransportMode(lines: readonly TransitLine[]): readonly NetworkLineGroup[] {
  const linesByMode = new Map<TransportMode, TransitLine[]>();
  for (const line of lines) {
    const mode = line.transportMode ?? "other";
    const groupLines = linesByMode.get(mode) ?? [];
    groupLines.push(line);
    linesByMode.set(mode, groupLines);
  }
  return NETWORK_GROUP_ORDER.filter((mode) => linesByMode.has(mode)).map((transportMode) => ({
    transportMode,
    lines: linesByMode.get(transportMode)!,
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
  coverage: DepartureBoardCoverage;
  isStacked: boolean;
}) {
  const groups = groupLinesByTransportMode(getGroupedLines(network.lines));
  // The bands as navigation, not a filter: the page always holds every mode, the bar says which
  // band it is being read in, and a button walks it to another.
  const linesRef = useRef<HTMLDivElement>(null);
  const { activeBandId, getBandRef, scrollToBand } = useNetworkBandNav(linesRef, {
    isEnabled: groups.length > 1,
    isPageScrollport: isStacked,
  });
  const bandItems = groups.map((group) => ({
    value: group.transportMode,
    label: networkGroupLabels[group.transportMode],
  })) satisfies readonly SegmentedControlItem<TransportMode>[];

  return (
    <div className="network-view">
      <div className="panel-heading">
        <div>
          <h1>Linien in Karlsruhe</h1>
        </div>
      </div>
      {groups.length > 1 && (
        <SegmentedControl
          className="network-band-nav"
          isNavigation
          value={activeBandId ?? groups[0].transportMode}
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
              key={group.transportMode}
              ref={getBandRef(group.transportMode)}
            >
              {/* The count says the group is the whole of its mode, not whatever happened to fit
                  on the first screen — the same honesty the observed list itself stands on. */}
              <h2 className="network-group-heading">
                <span>{networkGroupLabels[group.transportMode]}</span>
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
