import { useAppSettings, writeAppSettings, type AppSettings } from "../hooks";
import { type AppLanding } from "../lib/app-settings";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";

/**
 * One choice, named for what it changes and said in one line.
 *
 * The description carries what the label cannot — *Beim Öffnen* names a setting only to someone who
 * has already read what it decides — and the control stands on the right, where a row of the board
 * puts the answer to the question the row asks.
 */
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

/**
 * The rider's own choices about the app, each applied the moment it is made.
 *
 * Three settings, because three are true of the app as it stands: where it opens, whether it keeps
 * the stops a rider reads, and whether the line diagram draws the line's other vehicles at all.
 * Each is a device-local preference that the views already read — nothing here is
 * a new behaviour, only the place where the behaviour the app guessed at becomes a choice.
 */
export function SettingsView() {
  const settings = useAppSettings();
  const write = (partial: Partial<AppSettings>) => writeAppSettings({ ...settings, ...partial });

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
