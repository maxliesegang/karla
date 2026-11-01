/**
 * Another operator's line colour, chosen among lines of one name by where the journey starts and
 * ends: the operator whose area holds most of the ends outside the home municipality.
 */
import type {
  OperatorArea,
  OtherLineColors,
  PublishedLineColor,
} from "../networks/network-definition";

/** `RE 1` and `RE1` are one name. */
export const squashLineName = (name: string): string => name.replace(/\s+/g, "").toUpperCase();

/** A DHID's district (`de:08222` from `de:08222:2417`). */
export const getDistrict = (stopPointId: string): string =>
  stopPointId.split(":").slice(0, 2).join(":");

export type OtherLineColorSources = {
  areas: readonly OperatorArea[];
  colors: OtherLineColors;
  /** The network's own colour for a name, for lines of its operators run under another pool. */
  getHomeColor(lineId: string): PublishedLineColor | undefined;
  homeDistrict: string;
};

/** A district named in the area outweighs a state-wide area. */
function scoreArea(area: OperatorArea, districts: readonly string[]): number {
  return districts.reduce((score, district) => {
    if (area.districts.includes(district)) return score + 2;
    return area.districts.some((covered) => district.startsWith(covered)) ? score + 1 : score;
  }, 0);
}

export function findOtherLineColor(
  lineId: string,
  endStopPointIds: readonly string[],
  { areas, colors, getHomeColor, homeDistrict }: OtherLineColorSources,
): PublishedLineColor | undefined {
  const homeColor = getHomeColor(lineId);
  const homeAreaIndex = areas.findIndex(({ isHome }) => isHome);
  const candidates = [
    ...(colors[squashLineName(lineId)] ?? []),
    ...(homeColor && homeAreaIndex >= 0
      ? [[homeColor.color, homeAreaIndex, homeColor.textColor] as const]
      : []),
  ];
  if (candidates.length === 0) return undefined;

  const ends = endStopPointIds.map(getDistrict);
  const away = ends.filter((district) => district !== homeDistrict);
  const districts = away.length > 0 ? away : ends;
  const scored = candidates.map(([color, areaIndex, textColor]) => ({
    color,
    textColor,
    score: scoreArea(areas[areaIndex], districts),
  }));
  const best = Math.max(...scored.map(({ score }) => score));
  const winners = scored.filter(({ score }) => score === best);
  // Ends in no known area, or a tie between colours, leave the line neutral.
  if (best === 0 || new Set(winners.map(({ color }) => color)).size > 1) return undefined;
  const { color, textColor } = winners[0];
  return textColor ? { color, textColor } : { color };
}
