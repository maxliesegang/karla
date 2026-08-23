import type { TransitNetwork } from "../data/transit-types";
import { navigateTo, routePaths, type NetworkScope } from "../routing";
import { LineBadge } from "./LineBadge";
import { getGroupedLines } from "../lib/line-families";
import { LineTermini, getLineTerminiLabel } from "./LineTermini";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";

const networkScopeLabels: Record<NetworkScope, string> = {
  city: "Tram & Bus",
  region: "Alle Linien",
};
const networkScopeItems = (Object.keys(networkScopeLabels) as NetworkScope[]).map((value) => ({
  value,
  label: networkScopeLabels[value],
})) satisfies readonly SegmentedControlItem<NetworkScope>[];

/** The city scope hides the S-lines, which mostly run beyond the city and would crowd the list. */
const isWithinScope = (lineId: string, scope: NetworkScope) =>
  scope === "region" || !lineId.startsWith("S");

export function NetworkOverviewPanel({
  network,
  scope,
}: {
  network: TransitNetwork;
  scope: NetworkScope;
}) {
  const lines = getGroupedLines(network.lines).filter((line) => isWithinScope(line.id, scope));

  return (
    <div className="network-overview">
      <div className="panel-heading">
        <div>
          <h1>Linien in Karlsruhe</h1>
        </div>
        <SegmentedControl
          className="network-scope-control"
          value={scope}
          items={networkScopeItems}
          ariaLabel="Maßstab"
          onValueChange={(selectedScope) => navigateTo(routePaths.network(selectedScope))}
        />
      </div>

      <div className="network-lines">
        {lines.map((line) => (
          <button
            key={line.id}
            onClick={() => navigateTo(routePaths.line(line.id))}
            aria-label={`${getLineTerminiLabel(line)}. Linienverlauf öffnen`}
          >
            <LineBadge line={line} />
            <LineTermini line={line} className="network-termini" />
            <b aria-hidden="true">›</b>
          </button>
        ))}
      </div>
    </div>
  );
}
