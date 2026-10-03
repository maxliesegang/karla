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

const rememberingItems: readonly SegmentedControlItem<"on" | "off">[] = [
  { value: "on", label: "Merken", ariaLabel: "Besuchte Haltestellen merken" },
  { value: "off", label: "Vergessen", ariaLabel: "Besuchte Haltestellen nicht merken" },
];

const otherRunsItems: readonly SegmentedControlItem<"on" | "off">[] = [
  { value: "on", label: "Zeigen", ariaLabel: "Andere Fahrzeuge der Linie im Liniediagramm zeigen" },
  {
    value: "off",
    label: "Verstecken",
    ariaLabel: "Andere Fahrzeuge der Linie im Liniediagramm ausblenden",
  },
];

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
          description="Besuchte Haltestellen auf diesem Gerät aufbewahren"
          control={
            <SegmentedControl
              value={settings.isRememberingStops ? "on" : "off"}
              items={rememberingItems}
              ariaLabel="Haltestellen merken"
              onValueChange={(value) => write({ isRememberingStops: value === "on" })}
            />
          }
        />
        <SettingsRow
          title="Andere Fahrzeuge"
          description="Im Liniediagramm andere Fahrzeuge der Linie zeigen"
          control={
            <SegmentedControl
              value={settings.isShowingOtherLineRuns ? "on" : "off"}
              items={otherRunsItems}
              ariaLabel="Andere Fahrzeuge zeigen"
              onValueChange={(value) => write({ isShowingOtherLineRuns: value === "on" })}
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
    </section>
  );
}
