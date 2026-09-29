import { routePaths } from "../routing";

/**
 * The pages of KARLA, each named for what it holds and said in one line.
 *
 * *Linien* is the whole network's index; the line beneath each is what the name cannot carry on
 * its own. The lines page opens on the whole observed network, read in the modes it is made of
 * under the page's own band navigation.
 *
 * The notices are here as a page among the pages. They are also reachable from the provenance
 * footer, where they answer for the source; this is the same page reached as an index entry, which
 * is a different question asked in a different place.
 *
 * *Nähe* is not in this list because it is not a page a rider goes to: it is an action, and it
 * stands as one at the top of the home. Its `/nearby` view exists as the correction list that
 * action opens onto.
 *
 * The Zentrum is listed while its plan is still being built, marked as such here as on its page, so
 * a rider opening it knows what they are opening.
 */
const homeMenuItems: readonly {
  label: string;
  description: string;
  path: string;
  isInProgress?: boolean;
}[] = [
  {
    label: "Linien",
    description: "Stadtbahn, Straßenbahn und Bus des KVV",
    path: routePaths.network(),
  },
  {
    label: "Zentrum",
    description: "Die Bahn im Zentrum, live auf dem Plan",
    path: routePaths.zentrum(),
    isInProgress: true,
  },
  {
    label: "Meldungen",
    description: "Was der KVV gerade zum Betrieb meldet",
    path: routePaths.notices(),
  },
  {
    label: "Einstellungen",
    description: "Mach die App so, wie dir passt",
    path: routePaths.settings(),
  },
];

export function HomeMenu() {
  return (
    <nav className="home-menu" aria-labelledby="home-menu-heading">
      <h2 id="home-menu-heading" className="eyebrow">
        Seiten
      </h2>
      <ul>
        {homeMenuItems.map((item) => (
          <li key={item.path}>
            <a href={`#${item.path}`}>
              <span>
                <strong>
                  {item.label}
                  {item.isInProgress && <em className="home-menu-progress">In Arbeit</em>}
                </strong>
                <small>{item.description}</small>
              </span>
              <b aria-hidden="true">›</b>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
