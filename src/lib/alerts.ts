// Wording for GDACS disaster alerts.
import type { Alert, AlertType, CrisesFile } from "./data";

const TYPE_LABEL: Record<AlertType, string> = {
  earthquake: "earthquake",
  cyclone: "tropical cyclone",
  flood: "flood",
  drought: "drought",
  wildfire: "wildfire",
  volcano: "volcano",
  other: "disaster",
};

/** "Red tropical cyclone alert", as GDACS grades it. */
export function alertLabel(a: Alert): string {
  return `${a.level} ${TYPE_LABEL[a.type]} alert`;
}

/** The alerts that name a country. */
export function alertsFor(crises: CrisesFile | null, code: string): Alert[] {
  return crises ? crises.alerts.filter((a) => a.countries.includes(code)) : [];
}

/** "7 Oct" style date for an alert's start. */
export function alertDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
