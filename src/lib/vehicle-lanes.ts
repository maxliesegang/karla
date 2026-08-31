/** A lane remembered for one marker while it remains on the same directed diagram link. */
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
 * Keeps the sideways lane of every vehicle that is still on the same link.
 *
 * The domain list is ordered by soonest passage, so assigning lanes from scratch makes all the
 * other marks jump sideways whenever one vehicle enters or leaves a link. A lane is presentation
 * state instead: keep it while it is still available, then give newcomers the first free lane.
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

  // Every mark that can keep the lane it already had keeps it, before anything new is handed one.
  for (const vehicle of vehicles) {
    const linkKey = getLinkKey(vehicle);
    const remembered = previous.get(vehicle.markerKey);
    if (remembered?.linkKey !== linkKey || !isFree(linkKey, remembered.laneIndex)) continue;
    claim(vehicle.markerKey, linkKey, remembered.laneIndex);
  }

  // Then the newcomers, each into the first lane of its link still free.
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
