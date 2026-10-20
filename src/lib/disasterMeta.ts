// Names, colours and icons for each kind of disaster, shared by the map
// effects, the markers and the panels so they always agree.
import type { DisasterType, Severity } from "./data";

export interface DisasterMeta {
  /** "Flood" */
  label: string;
  /** "Floods" */
  plural: string;
  /** Strong colour for icons, outlines and the core of the effect. */
  color: string;
  /** Pale companion colour for highlights and glows. */
  light: string;
  /** SVG path data on a 24 x 24 grid, drawn as a 2 px stroke. */
  icon: string;
}

export const DISASTER_META: Record<DisasterType, DisasterMeta> = {
  earthquake: {
    label: "Earthquake",
    plural: "Earthquakes",
    color: "#c2410c",
    light: "#fdba74",
    icon: "M2 12h4l2-6 3 12 3-9 2 5 2-2h4",
  },
  tsunami: {
    label: "Tsunami",
    plural: "Tsunamis",
    color: "#1d4ed8",
    light: "#93c5fd",
    icon: "M3 18c3 0 4-2 6-2s3 2 6 2 3-2 6-2M5 13c0-4 3-8 8-8 3 0 5 2 5 4-2-1-5 0-5 3 0 1 1 2 2 2",
  },
  cyclone: {
    label: "Tropical cyclone",
    plural: "Tropical cyclones",
    color: "#6d28d9",
    light: "#c4b5fd",
    // The two-armed tropical cyclone symbol used on weather maps.
    icon: "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM12 9c0-3.5 3-6 8-6M12 15c0 3.5-3 6-8 6",
  },
  storm: {
    label: "Storm",
    plural: "Storms",
    color: "#475569",
    light: "#cbd5e1",
    icon: "M7 15a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 15M12 13l-2 4h3l-2 4",
  },
  flood: {
    label: "Flood",
    plural: "Floods",
    color: "#1e6fd9",
    light: "#9fd2ff",
    icon: "M2 8c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0M2 13c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0M2 18c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0",
  },
  landslide: {
    label: "Landslide",
    plural: "Landslides",
    color: "#8b5e34",
    light: "#d6b48c",
    icon: "M3 20h18L8 6zM15 15.5a1.2 1.2 0 1 0 0 .1M18.5 18a1 1 0 1 0 0 .1",
  },
  wildfire: {
    label: "Wildfire",
    plural: "Wildfires",
    color: "#dc2626",
    light: "#fdba74",
    icon: "M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z",
  },
  volcano: {
    label: "Volcano",
    plural: "Volcanoes",
    color: "#b91c1c",
    light: "#fca5a5",
    icon: "M3 20l6-9h6l6 9zM10 11 9 7.5M14 11l1-3.5M12 8V4",
  },
  drought: {
    label: "Drought",
    plural: "Droughts",
    color: "#b7791f",
    light: "#f6d58e",
    icon: "M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7zM12 1v1M4 7.5h1.5M18.5 7.5H20M3 20l4-2 2 2 3-3 3 3 2-2 4 2",
  },
  heatwave: {
    label: "Heatwave",
    plural: "Heatwaves",
    color: "#e11d48",
    light: "#fda4af",
    icon: "M10 13V5a2 2 0 1 1 4 0v8a4 4 0 1 1-4 0zM12 9v7",
  },
  coldwave: {
    label: "Cold wave",
    plural: "Cold waves",
    color: "#0891b2",
    light: "#a5f3fc",
    icon: "M12 2v20M4.5 7l15 10M4.5 17l15-10M9 4l3 2 3-2M9 20l3-2 3 2",
  },
  dust: {
    label: "Dust storm",
    plural: "Dust storms",
    color: "#a16207",
    light: "#e7c98f",
    icon: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8",
  },
};

export const SEVERITY_LABEL: Record<Severity, string> = { 1: "Minor", 2: "Significant", 3: "Severe" };

/** An inline SVG for the type's icon, for markers built outside React. */
export function iconSvg(type: DisasterType, size = 20, color = DISASTER_META[type].color): string {
  const d = DISASTER_META[type].icon;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
