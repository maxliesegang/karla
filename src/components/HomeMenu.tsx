import { routePaths } from "../routing";

/** The home's page links, each with one line of description. */
const homeMenuItems: readonly {
  label: string;
  description: string;
  path: string;
}[] = [
  {
    label: "Linien",
    description: "Bahn- und Buslinien, die gerade unterwegs sind",
    path: routePaths.network(),
  },
  {
    label: "Experimente",
    description: "Neue Kartenansichten ausprobieren",
    path: routePaths.experiment(),
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
                <strong>{item.label}</strong>
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
