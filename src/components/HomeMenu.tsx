import { routePaths } from "../routing";

/**
 * The home's page links, each with one line of description. *Nähe* is an action at the top of the
 * home, not a page here. The notices are also reachable from the footer. The Zentrum is marked as
 * an experiment.
 */
const homeMenuItems: readonly {
  label: string;
  description: string;
  path: string;
  isExperiment?: boolean;
}[] = [
  {
    label: "Linien",
    description: "Alle Bahn- und Buslinien im KVV",
    path: routePaths.network(),
  },
  {
    label: "Zentrum",
    description: "Wo die Bahnen in der Innenstadt gerade fahren",
    path: routePaths.zentrum(),
    isExperiment: true,
  },
  {
    label: "Meldungen",
    description: "Störungen, Umleitungen und Baustellen",
    path: routePaths.notices(),
  },
  {
    label: "Einstellungen",
    description: "Startseite und gemerkte Haltestellen",
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
                  {item.isExperiment && <em className="home-menu-progress">Experiment</em>}
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
