// Types for the JSON the pipeline writes into public/data, and loaders for it.
// The website reads nothing else.
import { cleanDisasters } from "./disasters";

export interface Article {
  title: string;
  /** Link to the article (a Google News link that redirects to the publisher). */
  url: string;
  /** Publisher name, e.g. "Bangkok Post". */
  outlet: string;
  /** Publisher home page, when known. */
  outletUrl: string | null;
  /** ISO 8601 publish time. */
  published: string;
  /** English headline, when translated. Equals title for English headlines. */
  en?: string;
  /** Country codes the headline is about, when known. */
  about?: string[];
}

/**
 * local: the country's own Google News top stories, what its public reads.
 * world: the country has no edition, so this is coverage about it from elsewhere.
 */
export type CoverageKind = "local" | "world";

export interface CountryFile {
  code: string;
  name: string;
  /** Absent in older files, which are all local. */
  kind?: CoverageKind;
  /** When this country's list was last refreshed. */
  updated: string;
  source: { name: string; edition: string; url: string };
  articles: Article[];
}

export interface IndexCountry {
  name: string;
  kind?: CoverageKind;
  articles: number;
  updated: string;
}

export interface IndexFile {
  /** When the pipeline last ran. */
  updated: string;
  countries: Record<string, IndexCountry>;
}

export interface SharedArticle {
  code: string;
  url: string;
  title: string;
  en: string;
  outlet: string;
  about?: string[];
}

export interface SharedStory {
  id: string;
  title: string;
  /** When the story was first seen; absent in older files. */
  since?: string;
  /** The country the story is mostly about; absent in older files. */
  subject?: string | null;
  /** Country codes reading it, most first. */
  countries: string[];
  articles: SharedArticle[];
}

export interface SharedFile {
  updated: string;
  stories: SharedStory[];
}

export interface AttentionFile {
  updated: string;
  /** mentions[TH][US] = how many of Thailand's top stories are about the US. */
  mentions: Record<string, Record<string, number>>;
}

export interface SnapshotArticle {
  title: string;
  en?: string;
  url: string;
  outlet: string;
}

export interface SnapshotStory {
  id: string;
  title: string;
  subject: string | null;
  countries: string[];
}

/** One UTC day as the pipeline last saw it. Local-edition countries only. */
export interface Snapshot {
  date: string;
  updated: string;
  countries: Record<string, SnapshotArticle[]>;
  stories: SnapshotStory[];
}

export interface HistoryIndex {
  /** Available days, oldest first, YYYY-MM-DD. */
  dates: string[];
}

/** A foreign top story about a country, with where it was read. */
export interface AboutArticle {
  from: string;
  url: string;
  title: string;
  en?: string;
  outlet: string;
  published: string;
}

export interface AboutFile {
  code: string;
  updated: string;
  articles: AboutArticle[];
}

/** Optional files: null when the pipeline has not produced them yet. */
async function loadOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return (await res.json()) as T;
}

export const loadShared = () => loadOptional<SharedFile>("/data/shared.json");
export const loadAttention = () => loadOptional<AttentionFile>("/data/attention.json");
export const loadHistoryIndex = () => loadOptional<HistoryIndex>("/data/history/index.json");
export const loadSnapshot = (date: string) => loadOptional<Snapshot>(`/data/history/${date}.json`);
export const loadAbout = (code: string) => loadOptional<AboutFile>(`/data/about/${code}.json`);

// Disasters: public/data/disasters.json, written by pipeline/lib/disasters.
// Same shapes as pipeline/lib/disasters/types.ts; coordinates are GeoJSON
// order, [longitude, latitude].

export type DisasterType =
  | "earthquake"
  | "tsunami"
  | "cyclone"
  | "storm"
  | "flood"
  | "landslide"
  | "wildfire"
  | "volcano"
  | "drought"
  | "heatwave"
  | "coldwave"
  | "dust";

/** 1 = minor or local, 2 = significant, 3 = severe. */
export type Severity = 1 | 2 | 3;
export type DisasterSource = "gdacs" | "usgs" | "eonet" | "ifrc" | "news";
export type Position = [number, number];
export type AreaGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

/** affected: footprint; wind: cyclone wind zone (level km/h); shaking: quake intensity (level MMI); place: around an affected place. */
export interface DisasterArea {
  kind: "affected" | "wind" | "shaking" | "place";
  level?: number;
  geometry: AreaGeometry;
}

export interface DisasterPlace {
  name: string;
  admin?: string;
  country: string;
  lat: number;
  lng: number;
  kind: "city" | "town" | "district" | "region" | "site";
  impact?: string;
  source: string;
}

export interface DisasterFigure {
  label: string;
  value: string;
  sourceName: string;
  sourceUrl: string;
}

export interface DisasterAppeal {
  code: string;
  name: string;
  kind: string;
  requested: number;
  funded: number;
  url: string;
  end: string;
}

export interface DonationLink {
  label: string;
  url: string;
  org: string;
  kind: "appeal" | "society" | "un" | "government" | "agency";
  note: string;
  via: "registry" | "research";
  /** A page for this disaster itself (its appeal, or a checked page researched for it). Missing in older files. */
  forEvent?: boolean;
}

export interface Disaster {
  id: string;
  type: DisasterType;
  title: string;
  severity: Severity;
  severityText?: string;
  countries: string[];
  lat: number;
  lng: number;
  /** exact: epicentre or mapped footprint; area: district or region; country: only the country is known. */
  precision: "exact" | "area" | "country";
  started: string;
  updated: string;
  areas: DisasterArea[];
  track?: { past: Position[]; forecast: Position[] };
  places: DisasterPlace[];
  summary?: string;
  summarySource?: { name: string; url: string };
  figures: DisasterFigure[];
  sources: { name: string; url: string }[];
  appeals: DisasterAppeal[];
  donate: DonationLink[];
  reportedBy: DisasterSource[];
  members: string[];
  /** summary is true when the summary was written by web research, not taken from a feed. */
  research?: { at: string; model: string; searches: number; summary?: boolean };
}

export interface DisastersFile {
  updated: string;
  fetched: Record<DisasterSource, string | null>;
  disasters: Disaster[];
}

/**
 * The disasters file, with malformed entries dropped (see cleanDisasters):
 * the pipeline is fed by outside feeds and web research, and one bad entry
 * must not blank the page.
 */
export async function loadDisasters(): Promise<DisastersFile | null> {
  const file = await loadOptional<DisastersFile>("/data/disasters.json");
  return file && { ...file, disasters: cleanDisasters(file.disasters) };
}

export async function loadIndex(): Promise<IndexFile> {
  const res = await fetch("/data/index.json");
  if (!res.ok) throw new Error(`Could not load index (${res.status})`);
  return (await res.json()) as IndexFile;
}

/** Resolves to null when the country has no data file. */
export async function loadCountry(code: string): Promise<CountryFile | null> {
  const res = await fetch(`/data/countries/${code}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${code} (${res.status})`);
  return (await res.json()) as CountryFile;
}
