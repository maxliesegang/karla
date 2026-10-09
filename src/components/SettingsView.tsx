import { useStoredPreference } from "../hooks/stored-preference";
import { appSettings, type AppSettings } from "../lib/app-settings";
import { type AppLanding } from "../lib/app-settings";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";

/** One setting: label, a line of description, the control on the right. */
function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <li className="settings-row">
      <span className="settings-row-text">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {control}
    </li>
  );
}

const landingItems: readonly SegmentedControlItem<AppLanding>[] = [
  {
    value: "recent-stop",
    label: "Letzte Haltestelle",
    ariaLabel: "Auf der letzten besuchten Haltestelle öffnen",
  },
  { value: "home", label: "Startseite", ariaLabel: "Auf der Startseite öffnen" },
];

/** An on/off setting, read by its row's title. */
function SettingsSwitch({
  isOn,
  label,
  onChange,
}: {
  isOn: boolean;
  label: string;
  onChange: (isOn: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="settings-switch"
      aria-checked={isOn}
      aria-label={label}
      onClick={() => onChange(!isOn)}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/** The rider's app settings, applied immediately. */
export function SettingsView() {
  const settings = useStoredPreference(appSettings);
  const write = (partial: Partial<AppSettings>) => appSettings.write({ ...settings, ...partial });

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <div className="panel-heading">
        <h1 id="settings-title">Einstellungen</h1>
      </div>
      <ul className="settings-list">
        <SettingsRow
          title="Beim Öffnen"
          description="Wohin KARLA springt, wenn du die App öffnest"
          control={
            <SegmentedControl
              value={settings.landing}
              items={landingItems}
              ariaLabel="Startansicht wählen"
              onValueChange={(landing) => write({ landing })}
            />
          }
        />
        <SettingsRow
          title="Haltestellen merken"
          description="Besuchte Haltestellen auf diesem Gerät aufbewahren. Ausschalten löscht die Liste."
          control={
            <SettingsSwitch
              isOn={settings.isRememberingStops}
              label="Haltestellen merken"
              onChange={(isRememberingStops) => write({ isRememberingStops })}
            />
          }
        />
        <SettingsRow
          title="Andere Fahrzeuge"
          description="Im Liniendiagramm andere Fahrzeuge der Linie zeigen"
          control={
            <SettingsSwitch
              isOn={settings.isShowingOtherLineRuns}
              label="Andere Fahrzeuge zeigen"
              onChange={(isShowingOtherLineRuns) => write({ isShowingOtherLineRuns })}
            />
          }
        />
      </ul>
      <p className="settings-footnote">
        Alles bleibt auf diesem Gerät: Einstellungen und besuchte Haltestellen werden nur lokal
        gespeichert und nirgendwohin gesendet. Auch dein Standort verlässt das Gerät nicht — er wird
        allein im Browser benutzt, um Haltestellen in der Nähe zu finden und deine Position auf der
        Linie zu zeigen.
      </p>
      <section className="settings-about" aria-labelledby="settings-about-title">
        <h2 id="settings-about-title">Daten & Haftung</h2>
        <p>
          KARLA ist kein offizielles Angebot des Karlsruher Verkehrsverbunds (KVV). Der KVV haftet
          nicht für die Inhalte dieser App.
        </p>
        <p>
          Abfahrten, Meldungen und Haltestellen stammen aus der elektronischen Fahrplanauskunft des
          KVV, Linien und Linienfarben aus seinen{" "}
          <a
            href="https://www.kvv.de/fahrplan/fahrplaene/open-data.html"
            target="_blank"
            rel="noreferrer"
          >
            Open Data
          </a>{" "}
          (CC0). Der KVV kann den Zugang zu diesen Daten jederzeit beschränken, ändern oder
          einstellen.
        </p>
      </section>
    </section>
  );
}
