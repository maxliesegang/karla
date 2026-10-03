/** A marker's lane, kept while it stays on the same directed link. */
export type VehicleLaneAssignment = {
  linkKey: string;
  laneIndex: number;
};

export type LaneAssignableVehicle = {
  markerKey: string;
  fromIndex: number;
  toIndex: number;
  directionArrow: "↑" | "↓";
  laneIndex: number;
};

const getLinkKey = ({ fromIndex, toIndex, directionArrow }: LaneAssignableVehicle): string =>
  `${fromIndex}:${toIndex}:${directionArrow}`;

/**
 * Keeps each vehicle's sideways lane while it stays on its link, so others do not jump when one
 * enters or leaves; newcomers get the first free lane.
 */
export function assignStableVehicleLanes<T extends LaneAssignableVehicle>(
  vehicles: readonly T[],
  previous: ReadonlyMap<string, VehicleLaneAssignment>,
): { vehicles: T[]; assignments: Map<string, VehicleLaneAssignment> } {
  const laneByMarker = new Map<string, VehicleLaneAssignment>();
  const usedByLink = new Map<string, Set<number>>();
  const isFree = (linkKey: string, laneIndex: number) => !usedByLink.get(linkKey)?.has(laneIndex);
  const claim = (markerKey: string, linkKey: string, laneIndex: number) => {
    const used = usedByLink.get(linkKey) ?? new Set<number>();
    used.add(laneIndex);
    usedByLink.set(linkKey, used);
    laneByMarker.set(markerKey, { linkKey, laneIndex });
  };

  // Existing lanes first.
  for (const vehicle of vehicles) {
    const linkKey = getLinkKey(vehicle);
    const remembered = previous.get(vehicle.markerKey);
    if (remembered?.linkKey !== linkKey || !isFree(linkKey, remembered.laneIndex)) continue;
    claim(vehicle.markerKey, linkKey, remembered.laneIndex);
  }

  // Then newcomers, into the first free lane.
  for (const vehicle of vehicles) {
    if (laneByMarker.has(vehicle.markerKey)) continue;
    const linkKey = getLinkKey(vehicle);
    let laneIndex = 0;
    while (!isFree(linkKey, laneIndex)) laneIndex += 1;
    claim(vehicle.markerKey, linkKey, laneIndex);
  }

  return {
    vehicles: vehicles.map((vehicle) => ({
      ...vehicle,
      laneIndex: laneByMarker.get(vehicle.markerKey)?.laneIndex ?? vehicle.laneIndex,
    })),
    assignments: laneByMarker,
  };
}
