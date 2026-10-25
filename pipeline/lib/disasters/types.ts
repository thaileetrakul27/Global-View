// Shared shapes for the disaster map.
//
// Each source module (gdacs, usgs, eonet, ifrc, news) turns its feed into
// SourceEvents. merge.ts clusters SourceEvents that describe the same
// disaster into one Disaster. Enrichment then adds affected places
// (geocode.ts), a researched summary and figures (research.ts) and
// donation pages (donate.ts, with direct giving from direct.ts). Only
// significant and severe disasters are published (build.ts). The site
// reads DisastersFile from
// public/data/disasters.json. Coordinates are always GeoJSON order:
// [longitude, latitude].

export type DisasterType =
  | "earthquake"
  | "tsunami"
  | "cyclone" // tropical cyclone, hurricane, typhoon
  | "storm" // other severe storm: windstorm, hail, blizzard
  | "flood"
  | "landslide"
  | "wildfire"
  | "volcano"
  | "drought"
  | "heatwave"
  | "coldwave"
  | "dust";

export const DISASTER_TYPES: readonly DisasterType[] = [
  "earthquake",
  "tsunami",
  "cyclone",
  "storm",
  "flood",
  "landslide",
  "wildfire",
  "volcano",
  "drought",
  "heatwave",
  "coldwave",
  "dust",
];

/** 1 = minor or local (GDACS green), 2 = significant (orange), 3 = severe (red). */
export type Severity = 1 | 2 | 3;

export type SourceName = "gdacs" | "usgs" | "eonet" | "ifrc" | "news";

/** Source priority when picking a disaster's id, title and centre: earlier wins. */
export const SOURCE_PRIORITY: readonly SourceName[] = ["gdacs", "usgs", "eonet", "ifrc", "news"];

/** [longitude, latitude] */
export type Position = [number, number];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}

export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

/**
 * affected: flood extent, burned area, drought region, generic footprint
 * wind:     cyclone wind buffer; level is the wind speed in km/h (60, 90, 120)
 * shaking:  earthquake intensity contour; level is the intensity (MMI)
 * place:    a buffer drawn around a geocoded affected place
 */
export type AreaKind = "affected" | "wind" | "shaking" | "place";

export interface Area {
  kind: AreaKind;
  level?: number;
  geometry: AreaGeometry;
}

/** A storm's path: where it has been and where it is forecast to go. */
export interface Track {
  past: Position[];
  forecast: Position[];
}

export interface SourceRef {
  name: string;
  url: string;
}

export type PlaceKind = "city" | "town" | "district" | "region" | "site";

/** A named place the disaster affects, with coordinates from a geocoder or the source. */
export interface Place {
  name: string;
  /** Province, state or district, when known. */
  admin?: string;
  /** Globe country code. */
  country: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  /** Short note from the source, e.g. "flooded", "evacuated", "epicentre". */
  impact?: string;
  source: "ifrc" | "research" | "news" | "usgs" | "gdacs" | "eonet";
}

/** A number reported by a source, e.g. deaths or people displaced. */
export interface Figure {
  label: string;
  value: string;
  sourceName: string;
  sourceUrl: string;
}

/** An IFRC operation (DREF or Emergency Appeal) responding to the disaster. Amounts in Swiss francs. */
export interface AppealRef {
  code: string;
  name: string;
  kind: string;
  requested: number;
  funded: number;
  url: string;
  end: string;
}

/**
 * Official links: appeal, society, un, government, agency. Direct giving
 * (direct.ts), always for the event itself and listed before the official
 * links: fundraiser (a fundraiser or relief fund on GoFundMe, from GoFundMe's
 * own verified page for the disaster), project (a GlobalGiving project or
 * fund for it, or a nonprofit's page for it that GoFundMe's page lists as a
 * vetted partner) and local (a local organisation's, school's or community
 * group's own donation page for it, found by research and live-checked).
 */
export type DonationKind = "appeal" | "society" | "un" | "government" | "agency" | "fundraiser" | "project" | "local";

/** The kinds of direct giving, in the order they are listed. */
export const DIRECT_KINDS: readonly DonationKind[] = ["fundraiser", "project", "local"];

/** A page where a reader can give. Never chosen by hand; see donate.ts and direct.ts for the rules. */
export interface DonationLink {
  label: string;
  url: string;
  org: string;
  kind: DonationKind;
  /** One short line; for direct giving, who checked the page. */
  note: string;
  /**
   * registry: from IFRC or UN lists by fixed rule. research: found by web
   * research and kept by fixed rules (the allowlist and a live check for
   * official pages; direct.ts's rules for GlobalGiving and local groups).
   * platform: by fixed rule from a giving platform's own vetted list
   * (GoFundMe's crisis pages).
   */
  via: "registry" | "research" | "platform";
  /**
   * True for a page about this very disaster rather than a general fund: the
   * IFRC appeal for it, a researched page the research marked as this
   * event's and that passed the allowlist and the live check, and every
   * direct link. Listed first.
   */
  forEvent?: boolean;
}

/**
 * How exact a location is. exact: an epicentre, storm centre or mapped
 * footprint. area: a district or region. country: only the country is
 * known (the marker sits at its centre until research finds places).
 */
export type Precision = "exact" | "area" | "country";

/** One report of a disaster from one source. */
export interface SourceEvent {
  source: SourceName;
  /** Stable within the source, e.g. "TC-1001338" (GDACS), "us7000abcd" (USGS), "EONET_25339", "7826" (IFRC GO event). */
  sourceId: string;
  type: DisasterType;
  title: string;
  severity: Severity;
  /** e.g. "Magnitude 6.6, depth 10 km" or "Winds up to 260 km/h". */
  severityText?: string;
  /**
   * News reports only: how many people the event's headlines say it killed,
   * as the model read them (news.ts); absent when none states a toll. A news
   * report's severity comes from this alone (merge.ts memberSeverity).
   */
  deaths?: number;
  /** Globe country codes, primary first. May be empty for events at sea. */
  countries: string[];
  lat: number;
  lng: number;
  precision: Precision;
  /** ISO 8601. */
  started: string;
  /** ISO 8601: the latest time the source saw the event active. */
  updated: string;
  areas: Area[];
  track?: Track;
  places?: Place[];
  summary?: string;
  figures?: Figure[];
  links: SourceRef[];
  /** GLIDE number, shared by GDACS, IFRC and ReliefWeb for the same disaster. */
  glide?: string;
  /** Normalised storm or volcano name for cross-source matching, e.g. "CHAMPI". */
  name?: string;
  /** Changes when the source's geometry changes (GDACS episode id). */
  revision?: string;
  appeals?: AppealRef[];
}

export interface Disaster {
  /** Stable across runs: kept from the previous file whenever any member carries over. */
  id: string;
  type: DisasterType;
  title: string;
  severity: Severity;
  severityText?: string;
  countries: string[];
  lat: number;
  lng: number;
  precision: Precision;
  started: string;
  updated: string;
  areas: Area[];
  track?: Track;
  places: Place[];
  summary?: string;
  summarySource?: SourceRef;
  figures: Figure[];
  sources: SourceRef[];
  appeals: AppealRef[];
  donate: DonationLink[];
  /** Which feeds reported it. */
  reportedBy: SourceName[];
  /** Member keys "source:sourceId", e.g. "gdacs:TC-1001338". */
  members: string[];
  /** When web research last added to this disaster; summary is true when the summary is research's own. */
  research?: { at: string; model: string; searches: number; summary?: boolean };
}

export interface DisastersFile {
  updated: string;
  /** Last successful fetch per source; null when never fetched. */
  fetched: Record<SourceName, string | null>;
  disasters: Disaster[];
}

/** The key merge.ts and the caches use for one source report. */
export function memberKey(e: Pick<SourceEvent, "source" | "sourceId">): string {
  return `${e.source}:${e.sourceId}`;
}
