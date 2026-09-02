import { navigateTo, routePaths, type HomeView } from "../routing";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";

const homeViewItems: readonly SegmentedControlItem<HomeView>[] = [
  { value: "zentrum", label: "Zentrum" },
  { value: "network", label: "Linien" },
];

const homePathByView: Record<HomeView, string> = {
  zentrum: routePaths.zentrum(),
  network: routePaths.network("city"),
};

/**
 * The two reference faces of the KARLA home, kept in one quiet segmented control.
 *
 * *Nähe* is not a reference face of the home: the bar control opens the likeliest stop immediately,
 * while its `/nearby` page exists only as the explicit correction list. Keeping that out of these
 * tabs means the home still says something before a location permission has been answered.
 */
export function HomeTabs({ activeView }: { activeView: HomeView }) {
  return (
    <SegmentedControl
      className="home-tabs"
      value={activeView}
      items={homeViewItems}
      ariaLabel="KARLA-Startseite"
      isNavigation
      onValueChange={(view) => navigateTo(homePathByView[view])}
    />
  );
}
