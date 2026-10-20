import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { circlePolygon, geometryAreaKm2, haversineKm, pointInGeometry } from "./geo";
import {
  AREA_MAX_BYTES,
  ATTRIBUTION,
  ATTRIBUTION_URL,
  MAX_AREA_KM2,
  MAX_LOOKUPS_PER_RUN,
  MISS_RETRY_DAYS,
  NOMINATIM_URL,
  PACE_MS,
  PLACE_RADIUS_KM,
  RETRY_MS,
  buildNominatimUrl,
  createGeocoder,
  geocodeKey,
  hasLatin,
  hitArea,
  inGlobeCountry,
  kindDistance,
  isCacheEntry,
  isFresh,
  mentionsAdmin,
  nominatimCountry,
  normaliseKeyPart,
  parseBbox,
  pickAdmin,
  pickBest,
  pickName,
  placeArea,
  placeFromHit,
  placeKind,
  readGeocodeCache,
  resultTier,
  searchNominatim,
  searchQuery,
  serialiseCache,
  territoryName,
  toGeoHit,
  unwrapBbox,
  writeGeocodeCache,
  type GeoHit,
  type GeocodeCache,
  type NominatimResult,
} from "./geocode";
import type { Place } from "./types";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** A real Nominatim response captured from this container (see fixtures/geocode-*.json). */
function fixture(name: string): NominatimResult[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `geocode-${name}.json`), "utf8")) as NominatimResult[];
}

const NOW = "2026-10-19T12:00:00.000Z";
const DAY_MS = 86_400_000;

/** A fetch that answers each search by its q parameter; unknown queries get an empty list. */
function routedFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    void _init;
    const url = new URL(String(input));
    const q = url.searchParams.get("q") ?? "";
    const body = q in routes ? routes[q] : [];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
}

function makeDeps(fetchImpl: FetchDeps["fetch"] | ReturnType<typeof vi.fn>): FetchDeps & { logs: string[]; sleep: ReturnType<typeof vi.fn> } {
  const logs: string[] = [];
  return {
    fetch: fetchImpl as FetchDeps["fetch"],
    sleep: vi.fn(async () => {}),
    log: (m: string) => void logs.push(m),
    logs,
  };
}

/** The q parameter of every request a fake fetch saw. */
function queriesOf(fetch: ReturnType<typeof vi.fn>): string[] {
  return fetch.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("q") ?? "");
}

function hit(over: Partial<GeoHit> = {}): GeoHit {
  return {
    name: "Bangkok",
    displayName: "Bangkok, Thailand",
    lat: 13.75,
    lng: 100.49,
    kind: "city",
    country: "TH",
    bbox: [100.3, 13.2, 100.9, 13.9],
    ...over,
  };
}

function result(over: Partial<NominatimResult> = {}): NominatimResult {
  return {
    lat: "10",
    lon: "20",
    category: "place",
    type: "town",
    place_rank: 18,
    addresstype: "town",
    name: "Sample",
    display_name: "Sample, Some Province, Thailand",
    boundingbox: ["9.9", "10.1", "19.9", "20.1"],
    address: { town: "Sample", province: "Some Province", country_code: "th" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("follow Nominatim's usage policy and credit OpenStreetMap", () => {
    expect(PACE_MS).toBeGreaterThanOrEqual(1000);
    expect(RETRY_MS).toBeGreaterThanOrEqual(PACE_MS);
    expect(MAX_LOOKUPS_PER_RUN).toBe(80);
    expect(MISS_RETRY_DAYS).toBe(30);
    expect(ATTRIBUTION).toContain("OpenStreetMap");
    expect(ATTRIBUTION).toContain("ODbL");
    expect(ATTRIBUTION_URL).toBe("https://www.openstreetmap.org/copyright");
    expect(PLACE_RADIUS_KM).toEqual({ city: 12, town: 6, district: 25, region: 60, site: 5 });
  });
});

// ---------------------------------------------------------------------------
// Names, keys and URLs
// ---------------------------------------------------------------------------

describe("nominatimCountry", () => {
  it("lower-cases ISO alpha-2 globe codes", () => {
    expect(nominatimCountry("TH")).toBe("th");
    expect(nominatimCountry(" bd ")).toBe("bd");
  });

  it("maps the globe's special codes to where OpenStreetMap files them", () => {
    expect(nominatimCountry("CYN")).toBe("cy"); // Northern Cyprus is under Cyprus
    expect(nominatimCountry("SOL")).toBe("so"); // Somaliland is under Somalia
    expect(nominatimCountry("XK")).toBe("xk"); // OSM uses xk for Kosovo
    expect(nominatimCountry("cyn")).toBe("cy");
  });

  it("returns null for codes it cannot map", () => {
    expect(nominatimCountry("")).toBeNull();
    expect(nominatimCountry("THA")).toBeNull();
    expect(nominatimCountry("T1")).toBeNull();
  });

  // Regression: countrycodes=pr, nc and tf return nothing live, so these globe countries never geocoded.
  it("searches territories in the country OpenStreetMap files them under", () => {
    expect(nominatimCountry("PR")).toBe("us");
    expect(nominatimCountry("nc")).toBe("fr");
    expect(nominatimCountry("TF")).toBe("fr");
  });
});

describe("territoryName", () => {
  it("names territories filed inside another country, and nothing else", () => {
    expect(territoryName("PR")).toBe("Puerto Rico");
    expect(territoryName(" nc ")).toBe("New Caledonia");
    expect(territoryName("TF")).toBe("French Southern and Antarctic Lands");
    expect(territoryName("US")).toBeUndefined();
    expect(territoryName("TH")).toBeUndefined();
  });
});

describe("inGlobeCountry", () => {
  const carolina = fixture("carolina"); // Carolina PR (US-PR), then Carolina in Alabama and Rhode Island
  const noumea = fixture("noumea")[0]; // fr, FR-NC

  it("matches the country code", () => {
    expect(inGlobeCountry(fixture("bangkok")[0], "TH")).toBe(true);
    expect(inGlobeCountry(fixture("bangkok")[0], "LA")).toBe(false);
    expect(inGlobeCountry(fixture("kyrenia")[0], "CYN")).toBe(true);
    expect(inGlobeCountry(result({ address: undefined }), "TH")).toBe(false);
    expect(inGlobeCountry(result(), "ZZZ")).toBe(false);
  });

  it("keeps a territory's places to the territory", () => {
    expect(carolina.map((r) => inGlobeCountry(r, "PR"))).toEqual([true, false, false]);
    expect(carolina.map((r) => inGlobeCountry(r, "US"))).toEqual([false, true, true]);
    expect(inGlobeCountry(noumea, "NC")).toBe(true);
    expect(inGlobeCountry(noumea, "FR")).toBe(false);
    expect(inGlobeCountry(noumea, "TF")).toBe(false);
  });

  it("leaves French Guiana in France, as the globe draws it", () => {
    const cayenne = result({ address: { city: "Cayenne", "ISO3166-2-lvl4": "FR-GF", country_code: "fr" } });
    expect(inGlobeCountry(cayenne, "FR")).toBe(true);
    expect(inGlobeCountry(cayenne, "NC")).toBe(false);
  });

  it("ignores subdivision codes that are not strings", () => {
    const odd = result({ address: { "ISO3166-2-lvl4": 7 as unknown as string, country_code: "us" } });
    expect(inGlobeCountry(odd, "US")).toBe(true);
    expect(inGlobeCountry(odd, "PR")).toBe(false);
  });
});

describe("normaliseKeyPart", () => {
  it("folds case, accents and punctuation", () => {
    expect(normaliseKeyPart("  Laâyoune–Sakia  El-Hamra ")).toBe("laayoune sakia el hamra");
    expect(normaliseKeyPart("St. John's")).toBe("st john s");
  });

  it("keeps letters of non-Latin scripts", () => {
    expect(normaliseKeyPart("กรุงเทพมหานคร")).not.toBe("");
    expect(normaliseKeyPart("حیدرآباد")).not.toBe("");
  });
});

describe("geocodeKey", () => {
  it("gives the same key for spelling variants", () => {
    expect(geocodeKey("bd", "Sunamganj", "Sylhet")).toBe(geocodeKey("BD", " SUNAMGANJ ", "sylhet"));
    expect(geocodeKey("BD", "Sunamganj", "Sylhet")).toBe("BD|sunamganj|sylhet");
  });

  it("separates names by admin and country", () => {
    expect(geocodeKey("BD", "Sunamganj")).toBe("BD|sunamganj|");
    expect(geocodeKey("BD", "Sunamganj")).not.toBe(geocodeKey("BD", "Sunamganj", "Sylhet"));
    expect(geocodeKey("IN", "Hyderabad")).not.toBe(geocodeKey("PK", "Hyderabad"));
  });

  it("keeps searches for an expected kind apart", () => {
    expect(geocodeKey("US", "Kilauea", undefined, "site")).toBe("US|kilauea||site");
    expect(geocodeKey("BD", "Sylhet", "Sylhet Division", "city")).toBe("BD|sylhet|sylhet division|city");
    expect(geocodeKey("BD", "Sylhet")).toBe("BD|sylhet|");
  });

  it("does not collapse names in other scripts to one key", () => {
    expect(geocodeKey("TH", "กรุงเทพ")).not.toBe(geocodeKey("TH", "เชียงใหม่"));
  });
});

describe("searchQuery", () => {
  it("joins name and admin", () => {
    expect(searchQuery("Sunamganj", "Sylhet")).toBe("Sunamganj, Sylhet");
  });

  it("drops a missing or repeated admin", () => {
    expect(searchQuery(" Bangkok ")).toBe("Bangkok");
    expect(searchQuery("Bangkok", "  ")).toBe("Bangkok");
    expect(searchQuery("Assam", "assam")).toBe("Assam");
  });
});

describe("buildNominatimUrl", () => {
  it("restricts to the country and asks for English names, addresses and outlines", () => {
    const url = new URL(buildNominatimUrl("Sunamganj, Sylhet", "bd"));
    expect(`${url.origin}${url.pathname}`).toBe(NOMINATIM_URL);
    const p = Object.fromEntries(url.searchParams);
    expect(p).toEqual({
      q: "Sunamganj, Sylhet",
      countrycodes: "bd",
      format: "jsonv2",
      addressdetails: "1",
      limit: "3",
      polygon_geojson: "1",
      polygon_threshold: "0.01",
      "accept-language": "en",
    });
  });

  it("uses another endpoint when given", () => {
    expect(buildNominatimUrl("x", "th", "http://localhost:8080/search")).toMatch(/^http:\/\/localhost:8080\/search\?q=x&/);
  });
});

describe("hasLatin and pickName", () => {
  it("detects Latin letters, accented ones included", () => {
    expect(hasLatin("Bangkok")).toBe(true);
    expect(hasLatin("Laâyoune")).toBe(true);
    expect(hasLatin("حیدرآباد")).toBe(false);
    expect(hasLatin("1234")).toBe(false);
  });

  it("keeps OpenStreetMap's name unless only the query is readable", () => {
    expect(pickName("Sylhet Division", "Sylhet")).toBe("Sylhet Division");
    expect(pickName("حیدرآباد", "Hyderabad")).toBe("Hyderabad");
    expect(pickName("กรุงเทพ", "กรุงเทพ")).toBe("กรุงเทพ");
    expect(pickName("", " Kyrenia ")).toBe("Kyrenia");
    expect(pickName(undefined, "Kyrenia")).toBe("Kyrenia");
  });
});

describe("pickAdmin", () => {
  it("takes the province or state from the address", () => {
    expect(pickAdmin({ city: "Sunamganj", state: "Sylhet Division", country_code: "bd" }, "Sunamganj")).toBe("Sylhet Division");
    expect(pickAdmin({ county: "Lumajang", state: "East Java" }, "Mount Semeru")).toBe("East Java");
    expect(pickAdmin({ province: "Chiang Mai Province" }, "Chiang Mai")).toBe("Chiang Mai Province");
  });

  it("skips the place itself and unreadable scripts", () => {
    expect(pickAdmin({ state: "Assam" }, "Assam")).toBeUndefined();
    expect(pickAdmin({ state: "سندھ", state_district: "Hyderabad Division" }, "Hyderabad")).toBe("Hyderabad Division");
  });

  it("falls back to the searched admin", () => {
    expect(pickAdmin({ city: "Pristina" }, "Pristina", "Prishtina District")).toBe("Prishtina District");
    expect(pickAdmin(undefined, "Assam", "assam")).toBeUndefined();
    expect(pickAdmin({}, "Pristina")).toBeUndefined();
  });

  // Regression: a search like "Derna, Libya" made the country the place's admin.
  it("never gives the country as the admin", () => {
    const derna = { city: "Derna", state: "Derna", country: "Libya", country_code: "ly" };
    expect(pickAdmin(derna, "Derna", "Libya")).toBeUndefined();
    expect(pickAdmin({ region: "Hong Kong", country: "China" }, "Hong Kong Island", "China")).toBe("Hong Kong");
  });
});

describe("mentionsAdmin", () => {
  const sunamganj = fixture("sunamganj")[0];

  it("finds the admin in the full label, ignoring words like Division or Province", () => {
    expect(mentionsAdmin(sunamganj, "Sylhet")).toBe(true);
    expect(mentionsAdmin(sunamganj, "Sylhet Division")).toBe(true);
    expect(mentionsAdmin(sunamganj, "Sylhet Province")).toBe(true);
  });

  it("matches whole words only", () => {
    expect(mentionsAdmin(sunamganj, "Dhaka")).toBe(false);
    expect(mentionsAdmin(sunamganj, "Syl")).toBe(false);
    expect(mentionsAdmin(sunamganj, "Province")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading results
// ---------------------------------------------------------------------------

describe("placeKind", () => {
  it("reads real results", () => {
    expect(placeKind(fixture("bangkok")[0])).toBe("city"); // a city that is also a province (rank 7)
    expect(placeKind(fixture("sylhet")[0])).toBe("region");
    expect(placeKind(fixture("assam")[0])).toBe("region");
    expect(placeKind(fixture("sunamganj")[1])).toBe("district"); // state_district
    expect(placeKind(fixture("hargeisa")[1])).toBe("district"); // county
    expect(placeKind(fixture("kyrenia")[1])).toBe("district");
    expect(placeKind(fixture("semeru")[0])).toBe("site"); // natural volcano
  });

  it("rejects a whole country", () => {
    expect(placeKind(fixture("thailand")[0])).toBeNull();
    expect(placeKind(result({ addresstype: "continent", place_rank: 2 }))).toBeNull();
    expect(placeKind(result({ addresstype: "town", place_rank: 4 }))).toBeNull();
  });

  it("treats villages and suburbs as towns", () => {
    expect(placeKind(result({ addresstype: "village", place_rank: 19 }))).toBe("town");
    expect(placeKind(result({ addresstype: "suburb", place_rank: 20 }))).toBe("town");
  });

  it("keeps protected areas as districts so their outline is drawn", () => {
    expect(placeKind(result({ category: "boundary", type: "protected_area", addresstype: "protected_area", place_rank: 25 }))).toBe("district");
  });

  it("falls back to place_rank for unknown address types", () => {
    const at = (rank: number) => placeKind(result({ addresstype: "something_new", place_rank: rank }));
    expect(at(8)).toBe("region");
    expect(at(12)).toBe("district");
    expect(at(16)).toBe("city");
    expect(at(18)).toBe("town");
    expect(at(28)).toBe("site");
    expect(placeKind(result({ addresstype: "something_new", place_rank: undefined }))).toBe("site");
  });
});

describe("kindDistance", () => {
  it("is 0 for the wanted size and grows with the gap", () => {
    const sylhet = fixture("sylhet-bare");
    expect(kindDistance(sylhet[1], "city")).toBe(0);
    expect(kindDistance(sylhet[1], "town")).toBe(0);
    expect(kindDistance(sylhet[0], "city")).toBe(2);
    expect(kindDistance(sylhet[0], "district")).toBe(1);
    expect(kindDistance(fixture("thailand")[0], "region")).toBe(3); // a whole country fits nothing
  });

  it("is 0 when nothing is wanted", () => {
    expect(kindDistance(fixture("sylhet-bare")[0])).toBe(0);
  });
});

describe("resultTier", () => {
  it("prefers settlements and administrative boundaries", () => {
    expect(resultTier(fixture("bangkok")[0])).toBe(0);
    expect(resultTier(fixture("sunamganj")[0])).toBe(0); // place=city
  });

  it("ranks natural features and protected areas second", () => {
    expect(resultTier(fixture("semeru")[0])).toBe(1);
    expect(resultTier(result({ category: "boundary", type: "national_park" }))).toBe(1);
    expect(resultTier(result({ category: "waterway", type: "river" }))).toBe(1);
  });

  it("never uses offices, museums, shops or roads", () => {
    const junk = fixture("chiangmai-admin");
    expect(junk.map(resultTier)).toEqual([null, null]); // office, tourism
    expect(resultTier(result({ category: "highway" }))).toBeNull();
    expect(resultTier(result({ category: "shop" }))).toBeNull();
    expect(resultTier(result({ category: undefined }))).toBeNull();
  });
});

describe("parseBbox", () => {
  it("reorders Nominatim's [minLat, maxLat, minLng, maxLng] strings", () => {
    expect(parseBbox(["13.2191019", "13.9551693", "100.3278772", "100.9386039"])).toEqual([100.3278772, 13.2191019, 100.9386039, 13.9551693]);
  });

  it("rejects anything else", () => {
    expect(parseBbox(undefined)).toBeNull();
    expect(parseBbox(["1", "2", "3"])).toBeNull();
    expect(parseBbox(["1", "2", "x", "4"])).toBeNull();
  });
});

// Regression: Nominatim gives places across the antimeridian a bbox from -180 to 180, the whole world.
describe("unwrapBbox", () => {
  it("rebuilds an island's bbox across 180 from its outline", () => {
    const taveuni = fixture("taveuni")[0];
    const raw = parseBbox(taveuni.boundingbox)!;
    expect(raw[2] - raw[0]).toBe(360);
    const [west, south, east, north] = unwrapBbox(raw, taveuni.geojson, -16.83, -179.94);
    expect(west).toBeCloseTo(179.887, 3);
    expect(east).toBeCloseTo(180.174, 3);
    expect([south, north]).toEqual([raw[1], raw[3]]);
  });

  it("does the same for a region without a kept outline", () => {
    const chukotka = fixture("chukotka")[0];
    const [west, , east] = unwrapBbox(parseBbox(chukotka.boundingbox)!, chukotka.geojson, 66, 169.5);
    expect(west).toBeCloseTo(157.73, 2);
    expect(east).toBeCloseTo(191.02, 2);
  });

  it("shrinks to the point without an outline, and leaves ordinary bboxes alone", () => {
    expect(unwrapBbox([-180, -17, 180, -16], { type: "Point", coordinates: [-179.9, -16.8] }, -16.8, -179.9)).toEqual([-179.9, -16.8, -179.9, -16.8]);
    const bkk: [number, number, number, number] = [100.33, 13.22, 100.94, 13.96];
    expect(unwrapBbox(bkk, undefined, 13.75, 100.49)).toBe(bkk);
  });

  it("puts a place just west of 180 in the western hemisphere", () => {
    const ring = [[-179.9, 1], [-179.5, 1], [-179.5, 2], [-179.9, 2], [-179.9, 1]];
    const out = unwrapBbox([-180, 1, 180, 2], { type: "Polygon", coordinates: [ring] }, 1.5, -179.7);
    [-179.9, 1, -179.5, 2].forEach((v, i) => expect(out[i]).toBeCloseTo(v, 9));
  });

  it("keeps a bbox that still wraps after unwrapping", () => {
    const band = { type: "Polygon", coordinates: [[[0, 1], [120, 1], [240, 1], [240, 2], [0, 2], [0, 1]]] };
    expect(unwrapBbox([-180, 1, 180, 2], band, 1.5, 0)).toEqual([-180, 1, 180, 2]);
  });
});

describe("hitArea", () => {
  it("keeps a district's or region's outline within the byte budget", () => {
    const sylhet = hitArea(fixture("sylhet")[0].geojson);
    expect(sylhet?.type).toBe("Polygon");
    expect(JSON.stringify(sylhet).length).toBeLessThanOrEqual(AREA_MAX_BYTES);
    expect(geometryAreaKm2(sylhet!)).toBeGreaterThan(10_000); // Sylhet Division is about 12,600 km2
    expect(geometryAreaKm2(sylhet!)).toBeLessThan(15_000);
    expect(pointInGeometry(91.87, 24.9, sylhet!)).toBe(true); // Sylhet city
  });

  it("simplifies a detailed outline down to the budget", () => {
    const detailed = circlePolygon(20, 80, 150, 4000);
    expect(JSON.stringify(detailed).length).toBeGreaterThan(AREA_MAX_BYTES);
    const fitted = hitArea(detailed);
    expect(fitted).toBeDefined();
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(AREA_MAX_BYTES);
  });

  it("drops outlines bigger than a specific area", () => {
    const raj = fixture("rajasthan")[0].geojson; // about 342,000 km2
    expect(geometryAreaKm2(raj as never)).toBeGreaterThan(MAX_AREA_KM2);
    expect(hitArea(raj)).toBeUndefined();
  });

  it("returns undefined for points and junk", () => {
    expect(hitArea(fixture("semeru")[0].geojson)).toBeUndefined();
    expect(hitArea(undefined)).toBeUndefined();
    expect(hitArea({ type: "Polygon", coordinates: [[[0, 0], [1, "x"]]] })).toBeUndefined();
  });
});

describe("toGeoHit", () => {
  it("reads a city without keeping its outline", () => {
    const h = toGeoHit(fixture("bangkok")[0], "th", "Bangkok");
    expect(h).toEqual({
      name: "Bangkok",
      displayName: "Bangkok, Thailand",
      lat: 13.7524938,
      lng: 100.4935089,
      kind: "city",
      country: "TH",
      bbox: [100.3278772, 13.2191019, 100.9386039, 13.9551693],
    });
  });

  it("keeps an outline for a district", () => {
    const h = toGeoHit(fixture("kottayam")[0], "IN", "Kottayam", "Kerala");
    expect(h?.kind).toBe("district");
    expect(h?.admin).toBe("Kerala");
    expect(h?.area?.type).toBe("Polygon");
  });

  it("uses the query's name when OpenStreetMap's is in an unreadable script", () => {
    expect(toGeoHit(fixture("hyderabad")[1], "PK", "Hyderabad")?.name).toBe("Hyderabad");
  });

  it("keeps an island across the antimeridian to its own bbox", () => {
    const h = toGeoHit(fixture("taveuni")[0], "FJ", "Taveuni");
    expect(h).toMatchObject({ name: "Taveuni", kind: "district", country: "FJ", admin: "Northern" });
    expect(h!.bbox[2] - h!.bbox[0]).toBeLessThan(1);
    expect(h!.bbox[0]).toBeCloseTo(179.887, 3);
    expect(h?.area?.type).toBe("MultiPolygon"); // split at 180 by OpenStreetMap
  });

  it("falls back to a point bbox and the name as label", () => {
    const h = toGeoHit(result({ boundingbox: undefined, display_name: undefined }), "TH", "Sample");
    expect(h?.bbox).toEqual([20, 10, 20, 10]);
    expect(h?.displayName).toBe("Sample");
  });

  it("rejects bad coordinates and whole countries", () => {
    expect(toGeoHit(result({ lat: "x" }), "TH", "Sample")).toBeNull();
    expect(toGeoHit(result({ lat: "95" }), "TH", "Sample")).toBeNull();
    expect(toGeoHit(result({ lon: undefined }), "TH", "Sample")).toBeNull();
    expect(toGeoHit(fixture("thailand")[0], "TH", "Thailand")).toBeNull();
  });
});

describe("pickBest", () => {
  it("finds Bangkok", () => {
    expect(pickBest(fixture("bangkok"), "TH", "Bangkok")?.kind).toBe("city");
  });

  it("finds Sylhet Division and Assam with their outlines", () => {
    const sylhet = pickBest(fixture("sylhet"), "BD", "Sylhet Division");
    expect(sylhet).toMatchObject({ name: "Sylhet Division", kind: "region", country: "BD" });
    expect(sylhet?.area).toBeDefined();
    const assam = pickBest(fixture("assam"), "IN", "Assam");
    expect(assam).toMatchObject({ name: "Assam", kind: "region" });
    expect(assam?.admin).toBeUndefined();
    expect(JSON.stringify(assam?.area).length).toBeLessThanOrEqual(AREA_MAX_BYTES);
  });

  it("returns null for a miss", () => {
    expect(pickBest(fixture("miss"), "PH", "Xqzvplorth Kandabarra")).toBeNull();
  });

  it("only accepts results in the expected country", () => {
    const results = fixture("hyderabad"); // India first, then two in Pakistan
    expect(pickBest(results, "IN", "Hyderabad")).toMatchObject({ country: "IN", admin: "Telangana", kind: "city" });
    expect(pickBest(results, "PK", "Hyderabad")).toMatchObject({ country: "PK", name: "Hyderabad", admin: "Sindh" });
    expect(pickBest(results, "BD", "Hyderabad")).toBeNull();
  });

  it("maps special globe codes for the country check", () => {
    expect(pickBest(fixture("kyrenia"), "CYN", "Kyrenia")).toMatchObject({ country: "CYN", kind: "city" });
    expect(pickBest(fixture("hargeisa"), "SOL", "Hargeisa")).toMatchObject({ country: "SOL", kind: "city" });
    expect(pickBest(fixture("pristina"), "XK", "Pristina")).toMatchObject({ country: "XK", kind: "city" });
    expect(pickBest(fixture("pristina"), "RS", "Pristina")).toBeNull();
  });

  it("tells a territory's places from the rest of the country", () => {
    expect(pickBest(fixture("carolina"), "PR", "Carolina")).toMatchObject({ country: "PR", admin: "Puerto Rico", kind: "district" });
    expect(pickBest(fixture("carolina"), "US", "Carolina")).toMatchObject({ country: "US", admin: "Alabama", kind: "town" });
    expect(pickBest(fixture("noumea"), "NC", "Noumea")).toMatchObject({ country: "NC", kind: "city", admin: "South Province" });
    expect(pickBest(fixture("noumea"), "FR", "Noumea")).toBeNull();
  });

  it("never takes offices or museums, or a whole country", () => {
    expect(pickBest(fixture("chiangmai-admin"), "TH", "Chiang Mai", "Northern Thailand")).toBeNull();
    expect(pickBest(fixture("thailand"), "TH", "Thailand")).toBeNull();
  });

  it("keeps a large region's point but not its outline", () => {
    const raj = pickBest(fixture("rajasthan"), "IN", "Rajasthan");
    expect(raj?.kind).toBe("region");
    expect(raj?.area).toBeUndefined();
  });

  it("prefers settlements to natural features, then Nominatim's order", () => {
    const river = result({ category: "waterway", type: "river", name: "Sample River", lat: "1", lon: "1" });
    const town = result({ name: "Sample Town", lat: "2", lon: "2" });
    const city = result({ addresstype: "city", place_rank: 16, name: "Sample City", lat: "3", lon: "3" });
    expect(pickBest([river, town, city], "TH", "Sample")?.name).toBe("Sample Town");
    expect(pickBest([river], "TH", "Sample")?.kind).toBe("site");
  });

  // Regression: "Kilauea" put the volcano on a village of that name on Kauai, about 530 km away.
  it("prefers natural features when looking for a site", () => {
    const kilauea = fixture("kilauea"); // village on Kauai first, the volcano on Hawaii second
    expect(pickBest(kilauea, "US", "Kilauea")).toMatchObject({ kind: "town", lat: 22.2087822 });
    expect(pickBest(kilauea, "US", "Kilauea", undefined, undefined, "site")).toMatchObject({ name: "Kīlauea", kind: "site", lat: 19.4138647 });
    expect(pickBest(kilauea, "US", "Kilauea", undefined, undefined, "town")).toMatchObject({ kind: "town" });
    const town = result({ name: "Only Town" });
    expect(pickBest([town], "TH", "Only Town", undefined, undefined, "site")?.name).toBe("Only Town");
  });

  // Regression: "Sylhet" for a flooded city drew all 12,600 km2 of Sylhet Division, Nominatim's first result.
  it("prefers the kind the caller expects among places of the same name", () => {
    const sylhet = fixture("sylhet-bare"); // Sylhet Division, then Sylhet city
    expect(pickBest(sylhet, "BD", "Sylhet")).toMatchObject({ kind: "region" });
    expect(pickBest(sylhet, "BD", "Sylhet", undefined, undefined, "city")).toMatchObject({ name: "Sylhet", kind: "city" });
    expect(pickBest(sylhet, "BD", "Sylhet", undefined, undefined, "town")).toMatchObject({ kind: "city" });
    expect(pickBest(sylhet, "BD", "Sylhet", undefined, undefined, "region")).toMatchObject({ kind: "region" });
    const kottayam = fixture("kottayam"); // district, city, county
    expect(pickBest(kottayam, "IN", "Kottayam", "Kerala", undefined, "city")?.kind).toBe("city");
    expect(pickBest(kottayam, "IN", "Kottayam", "Kerala", undefined, "district")?.lat).toBe(9.6287383);
  });

  it("puts the province before the kind", () => {
    const inBatangas = result({ name: "San Jose", addresstype: "state", place_rank: 8, display_name: "San Jose, Batangas, Philippines", address: { country_code: "ph" } });
    const elsewhere = result({ name: "San Jose", display_name: "San Jose, Nueva Ecija, Philippines", address: { country_code: "ph" } });
    expect(pickBest([elsewhere, inBatangas], "PH", "San Jose", undefined, "Batangas", "town")?.displayName).toContain("Batangas");
  });

  it("prefers a result in the given province when asked", () => {
    const north = result({ name: "San Jose", display_name: "San Jose, Nueva Ecija, Philippines", address: { country_code: "ph" } });
    const south = result({ name: "San Jose", display_name: "San Jose, Batangas, Philippines", address: { country_code: "ph" }, lat: "13.8" });
    expect(pickBest([north, south], "PH", "San Jose")?.displayName).toContain("Nueva Ecija");
    expect(pickBest([north, south], "PH", "San Jose", undefined, "Batangas Province")?.displayName).toContain("Batangas");
  });

  it("skips unusable entries and non-lists", () => {
    expect(pickBest({ error: "bad" }, "TH", "x")).toBeNull();
    expect(pickBest([null, 3, "x", result({ lat: "nope" }), result({ name: "Good" })], "TH", "x")?.name).toBe("Good");
    expect(pickBest([result({ address: { country_code: 7 as unknown as string } })], "TH", "x")).toBeNull();
    expect(pickBest([result()], "ZZZ", "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe("isFresh", () => {
  it("always serves hits", () => {
    expect(isFresh({ hit: hit(), at: "2020-01-01T00:00:00Z" }, NOW)).toBe(true);
  });

  it("serves misses until they are 30 days old", () => {
    const at = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
    expect(isFresh({ hit: null, at: at(29) }, NOW)).toBe(true);
    expect(isFresh({ hit: null, at: at(30) }, NOW)).toBe(false);
    expect(isFresh({ hit: null, at: at(3) }, NOW, 2)).toBe(false);
  });

  it("treats missing or undated entries as stale", () => {
    expect(isFresh(undefined, NOW)).toBe(false);
    expect(isFresh({ hit: null, at: "yesterday" }, NOW)).toBe(false);
  });
});

describe("isCacheEntry", () => {
  it("accepts hits and misses", () => {
    expect(isCacheEntry({ hit: hit(), at: NOW })).toBe(true);
    expect(isCacheEntry({ hit: null, at: NOW })).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(isCacheEntry(null)).toBe(false);
    expect(isCacheEntry({ hit: null })).toBe(false);
    expect(isCacheEntry({ hit: null, at: "not a date" })).toBe(false);
    expect(isCacheEntry({ hit: { ...hit(), lat: "13" }, at: NOW })).toBe(false);
    expect(isCacheEntry({ hit: { ...hit(), kind: "planet" }, at: NOW })).toBe(false);
    expect(isCacheEntry({ hit: { ...hit(), bbox: undefined }, at: NOW })).toBe(false);
    expect(isCacheEntry({ at: NOW })).toBe(false);
  });
});

describe("cache files", () => {
  function tmpFile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "geocode-")), "nested", "geocode.json");
  }

  it("round-trips, creating folders", () => {
    const file = tmpFile();
    const cache: GeocodeCache = { "TH|bangkok|": { hit: hit(), at: NOW }, "PH|nowhere|": { hit: null, at: NOW } };
    writeGeocodeCache(cache, file);
    expect(readGeocodeCache(file)).toEqual(cache);
  });

  it("writes one entry per line, sorted by key", () => {
    const text = serialiseCache({ "TH|b|": { hit: null, at: NOW }, "BD|a|": { hit: null, at: NOW } });
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^"BD\|a\|": /);
    expect(lines[2]).toMatch(/^"TH\|b\|": /);
    expect(JSON.parse(text)).toHaveProperty(["BD|a|"]);
    expect(serialiseCache({})).toBe("{}\n");
  });

  it("gives an empty cache for a missing or broken file, and drops bad entries", () => {
    const file = tmpFile();
    expect(readGeocodeCache(file)).toEqual({});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readGeocodeCache(file)).toEqual({});
    fs.writeFileSync(file, "[1, 2]");
    expect(readGeocodeCache(file)).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ good: { hit: null, at: NOW }, bad: { hit: "x", at: NOW } }));
    expect(readGeocodeCache(file)).toEqual({ good: { hit: null, at: NOW } });
  });
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe("searchNominatim", () => {
  const url = buildNominatimUrl("Bangkok", "th");

  it("returns the result list and identifies itself", async () => {
    const fetch = routedFetch({ Bangkok: fixture("bangkok") });
    const deps = makeDeps(fetch);
    const results = await searchNominatim(url, deps);
    expect(results).toHaveLength(1);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("retries once after a failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture("bangkok")), { status: 200 }));
    const deps = makeDeps(fetch);
    expect(await searchNominatim(url, deps, 1234)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(1234);
    expect(deps.logs[0]).toContain("socket hang up");
  });

  // Regression: a 400 for one over-long name was retried, then stopped every later search in the run.
  it("answers a query Nominatim rejects with an empty list, without a retry", async () => {
    const tooLong = fs.readFileSync(path.join(FIXTURES, "geocode-toolong.json"), "utf8"); // real 400 body
    for (const [body, status] of [[tooLong, 400], ["Error: URI Too Long", 414]] as const) {
      const fetch = vi.fn(async () => new Response(body, { status }));
      const deps = makeDeps(fetch);
      expect(await searchNominatim(url, deps)).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(deps.sleep).not.toHaveBeenCalled();
      expect(deps.logs[0]).toContain(`rejected (HTTP ${status})`);
    }
  });

  it("returns null when both attempts fail, whatever the failure", async () => {
    for (const [body, status] of [["[]", 429], ["<html>busy</html>", 200], ['{"error":"Unable to geocode"}', 200]] as const) {
      const fetch = vi.fn(async () => new Response(body, { status }));
      const deps = makeDeps(fetch);
      expect(await searchNominatim(url, deps)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(deps.sleep).toHaveBeenCalledWith(RETRY_MS);
    }
  });
});

describe("createGeocoder", () => {
  it("geocodes from Nominatim, writes the cache, then serves from it", async () => {
    const fetch = routedFetch({ Bangkok: fixture("bangkok") });
    const deps = makeDeps(fetch);
    const cache: GeocodeCache = {};
    const geo = createGeocoder(deps, cache, NOW);

    const first = await geo.geocode("Bangkok", "TH");
    expect(first).toMatchObject({ name: "Bangkok", kind: "city", country: "TH" });
    expect(cache["TH|bangkok|"]).toEqual({ hit: first, at: NOW });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("countrycodes")).toBe("th");
    expect(url.searchParams.get("q")).toBe("Bangkok");

    expect(await geo.geocode(" bangkok ", "th")).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(geo.lookups).toBe(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("serves earlier runs' hits without asking again", async () => {
    const fetch = routedFetch({});
    const cache: GeocodeCache = { "TH|bangkok|": { hit: hit(), at: "2025-01-01T00:00:00Z" } };
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode("Bangkok", "TH")).toEqual(hit());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends 'name, admin' and keeps the admin from the address", async () => {
    const fetch = routedFetch({ "Sunamganj, Sylhet": fixture("sunamganj") });
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    expect(await geo.geocode("Sunamganj", "BD", "Sylhet")).toMatchObject({ name: "Sunamganj", admin: "Sylhet Division", kind: "city" });
    expect(queriesOf(fetch)).toEqual(["Sunamganj, Sylhet"]);
  });

  it("paces requests at least PACE_MS apart, starting without a wait", async () => {
    const fetch = routedFetch({ Bangkok: fixture("bangkok"), "Sylhet Division": fixture("sylhet"), Assam: fixture("assam") });
    const deps = makeDeps(fetch);
    const order: string[] = [];
    deps.sleep.mockImplementation(async (ms: number) => void order.push(`sleep ${ms}`));
    fetch.mockImplementation(async (input: string | URL | Request) => {
      const q = new URL(String(input)).searchParams.get("q")!;
      order.push(`fetch ${q}`);
      const body = q === "Bangkok" ? fixture("bangkok") : q === "Assam" ? fixture("assam") : fixture("sylhet");
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const geo = createGeocoder(deps, {}, NOW);
    await geo.geocode("Bangkok", "TH");
    await geo.geocode("Sylhet Division", "BD");
    await geo.geocode("Assam", "IN");
    expect(order).toEqual(["fetch Bangkok", `sleep ${PACE_MS}`, "fetch Sylhet Division", `sleep ${PACE_MS}`, "fetch Assam"]);
  });

  it("runs concurrent calls one at a time and shares duplicate ones", async () => {
    let active = 0;
    let most = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const q = new URL(String(input)).searchParams.get("q");
      return new Response(JSON.stringify(q === "Assam" ? fixture("assam") : fixture("bangkok")), { status: 200 });
    });
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    const [a, b, c] = await Promise.all([geo.geocode("Bangkok", "TH"), geo.geocode("Bangkok", "TH"), geo.geocode("Assam", "IN")]);
    expect(most).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
    expect(c?.name).toBe("Assam");
  });

  it("caches a miss and asks again only after 30 days", async () => {
    const fetch = routedFetch({});
    const cache: GeocodeCache = {};
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode("Xqzvplorth Kandabarra", "PH")).toBeNull();
    expect(cache["PH|xqzvplorth kandabarra|"]).toEqual({ hit: null, at: NOW });
    expect(await geo.geocode("Xqzvplorth Kandabarra", "PH")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    const later = new Date(Date.parse(NOW) + 31 * DAY_MS).toISOString();
    const geo2 = createGeocoder(makeDeps(fetch), cache, later);
    expect(await geo2.geocode("Xqzvplorth Kandabarra", "PH")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache["PH|xqzvplorth kandabarra|"].at).toBe(later);
  });

  it("caches a result from the wrong country as a miss", async () => {
    const fetch = routedFetch({ Hyderabad: fixture("hyderabad") });
    const cache: GeocodeCache = {};
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode("Hyderabad", "BD")).toBeNull();
    expect(cache["BD|hyderabad|"]).toEqual({ hit: null, at: NOW });
  });

  it("searches the name alone when 'name, admin' finds nothing usable", async () => {
    const fetch = routedFetch({ "Chiang Mai, Northern Thailand": fixture("chiangmai-admin"), "Chiang Mai": fixture("chiangmai") });
    const deps = makeDeps(fetch);
    const cache: GeocodeCache = {};
    const geo = createGeocoder(deps, cache, NOW);
    const h = await geo.geocode("Chiang Mai", "TH", "Northern Thailand");
    expect(h).toMatchObject({ name: "Chiang Mai City Municipality", admin: "Chiang Mai Province", kind: "city" });
    expect(queriesOf(fetch)).toEqual(["Chiang Mai, Northern Thailand", "Chiang Mai"]);
    expect(geo.lookups).toBe(2);
    expect(deps.sleep).toHaveBeenCalledWith(PACE_MS);
    expect(cache["TH|chiang mai|northern thailand"]?.hit).toEqual(h);
  });

  it("does not stand in an unconfirmed admin on the fallback search", async () => {
    const bare = result({ name: "Sample", address: { town: "Sample", country_code: "th" } });
    const fetch = routedFetch({ Sample: [bare] });
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    const h = await geo.geocode("Sample", "TH", "Nowhere Land");
    expect(h?.name).toBe("Sample");
    expect(h?.admin).toBeUndefined();
  });

  it("does not search twice when the admin repeats the name", async () => {
    const fetch = routedFetch({});
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    expect(await geo.geocode("Assam", "IN", "Assam")).toBeNull();
    expect(queriesOf(fetch)).toEqual(["Assam"]);
  });

  it("maps special globe codes in the request and keeps them on the hit", async () => {
    const fetch = routedFetch({ Kyrenia: fixture("kyrenia"), Hargeisa: fixture("hargeisa") });
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    expect((await geo.geocode("Kyrenia", "CYN"))?.country).toBe("CYN");
    expect((await geo.geocode("Hargeisa", "SOL"))?.country).toBe("SOL");
    const codes = fetch.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("countrycodes"));
    expect(codes).toEqual(["cy", "so"]);
  });

  it("narrows a territory's search with its name and keeps only its places", async () => {
    const fetch = routedFetch({ Carolina: fixture("carolina"), "Noumea, New Caledonia": fixture("noumea") });
    const cache: GeocodeCache = {};
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode("Carolina", "PR")).toMatchObject({ country: "PR", admin: "Puerto Rico", lat: expect.closeTo(18.4, 1) });
    expect(await geo.geocode("Noumea", "NC")).toMatchObject({ country: "NC", name: "Noumea" });
    expect(queriesOf(fetch)).toEqual(["Carolina, Puerto Rico", "Carolina", "Noumea, New Caledonia"]);
    const codes = fetch.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("countrycodes"));
    expect(codes).toEqual(["us", "us", "fr"]);
    expect(Object.keys(cache).sort()).toEqual(["NC|noumea|", "PR|carolina|"]);
  });

  // Regression: one rejected query switched the geocoder off for the rest of the run, and was never cached.
  it("caches a rejected query as a miss and keeps searching", async () => {
    const tooLong = fs.readFileSync(path.join(FIXTURES, "geocode-toolong.json"), "utf8");
    const long = Array.from({ length: 60 }, () => "Sylhet").join(" ");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const q = new URL(String(input)).searchParams.get("q");
      return q === long ? new Response(tooLong, { status: 400 }) : new Response(JSON.stringify(fixture("bangkok")), { status: 200 });
    });
    const cache: GeocodeCache = {};
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode(long, "BD")).toBeNull();
    expect(await geo.geocode("Bangkok", "TH")).toMatchObject({ name: "Bangkok" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache[geocodeKey("BD", long)]).toEqual({ hit: null, at: NOW });
    expect(geo.deferred).toBe(0);
  });

  it("looks for the kind the caller expects and caches it apart", async () => {
    const fetch = routedFetch({ Kilauea: fixture("kilauea"), Sylhet: fixture("sylhet-bare") });
    const cache: GeocodeCache = {};
    const geo = createGeocoder(makeDeps(fetch), cache, NOW);
    expect(await geo.geocode("Kilauea", "US", undefined, "site")).toMatchObject({ name: "Kīlauea", kind: "site" });
    expect(await geo.geocode("Kilauea", "US")).toMatchObject({ name: "Kilauea", kind: "town" });
    expect(await geo.geocode("Sylhet", "BD", undefined, "city")).toMatchObject({ name: "Sylhet", kind: "city" });
    expect(Object.keys(cache).sort()).toEqual(["BD|sylhet||city", "US|kilauea|", "US|kilauea||site"]);
    expect(await geo.geocode("Kilauea", "US", undefined, "site")).toMatchObject({ kind: "site" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops at the per-run cap without caching the rest", async () => {
    const fetch = routedFetch({ Bangkok: fixture("bangkok") });
    const deps = makeDeps(fetch);
    const cache: GeocodeCache = {};
    const geo = createGeocoder(deps, cache, NOW, { maxLookups: 1 });
    expect(await geo.geocode("Bangkok", "TH")).not.toBeNull();
    expect(await geo.geocode("Assam", "IN")).toBeNull();
    expect(await geo.geocode("Sylhet Division", "BD")).toBeNull();
    expect(await geo.geocode("Bangkok", "TH")).not.toBeNull(); // cached hits are still served
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(cache)).toEqual(["TH|bangkok|"]);
    expect(geo.lookups).toBe(1);
    expect(geo.deferred).toBe(2);
    expect(deps.logs.filter((l) => l.includes("wait for the next run"))).toHaveLength(1);
  });

  it("stops searching for the run once a search fails twice, caching nothing", async () => {
    const fetch = vi.fn(async () => new Response("Too Many Requests", { status: 429 }));
    const deps = makeDeps(fetch);
    const cache: GeocodeCache = {};
    const geo = createGeocoder(deps, cache, NOW);
    expect(await geo.geocode("Bangkok", "TH")).toBeNull();
    expect(await geo.geocode("Assam", "IN")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); // one search and its retry
    expect(cache).toEqual({});
    expect(geo.deferred).toBe(2);
    expect(deps.logs.some((l) => l.includes("no more searches this run"))).toBe(true);
  });

  it("never waits less than PACE_MS before a retry", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const deps = makeDeps(fetch);
    await createGeocoder(deps, {}, NOW, { retryMs: 10 }).geocode("Bangkok", "TH");
    expect(deps.sleep).toHaveBeenCalledWith(PACE_MS);
  });

  it("returns null without a request for unmappable countries and empty names", async () => {
    const fetch = routedFetch({});
    const geo = createGeocoder(makeDeps(fetch), {}, NOW);
    expect(await geo.geocode("Bangkok", "THA")).toBeNull();
    expect(await geo.geocode("  ", "TH")).toBeNull();
    expect(await geo.geocode("...", "TH")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(geo.lookups).toBe(0);
  });

  it("never throws, even when a dependency does", async () => {
    const fetch = routedFetch({});
    const deps = makeDeps(fetch);
    deps.sleep.mockRejectedValue(new Error("sleep broke"));
    const geo = createGeocoder(deps, {}, NOW);
    expect(await geo.geocode("Bangkok", "TH")).toBeNull(); // first search needs no sleep: a cached miss
    expect(await geo.geocode("Assam", "IN")).toBeNull(); // paced sleep throws
    expect(deps.logs.some((l) => l.includes("sleep broke"))).toBe(true);
    expect(await geo.geocode("Sylhet Division", "BD")).toBeNull(); // the queue still works afterwards
  });

  it("uses another endpoint when given", async () => {
    const fetch = routedFetch({});
    await createGeocoder(makeDeps(fetch), {}, NOW, { endpoint: "http://localhost:9/search" }).geocode("Bangkok", "TH");
    expect(String(fetch.mock.calls[0][0])).toMatch(/^http:\/\/localhost:9\/search\?/);
  });
});

// ---------------------------------------------------------------------------
// Places and areas
// ---------------------------------------------------------------------------

describe("placeFromHit", () => {
  it("copies the hit's position, kind and admin", () => {
    const h = hit({ name: "Sunamganj", admin: "Sylhet Division", country: "BD", lat: 25.07, lng: 91.4 });
    expect(placeFromHit(h, " flooded ", "research")).toEqual({
      name: "Sunamganj",
      admin: "Sylhet Division",
      country: "BD",
      lat: 25.07,
      lng: 91.4,
      kind: "city",
      impact: "flooded",
      source: "research",
    });
  });

  it("leaves out an empty impact and a missing admin", () => {
    const p = placeFromHit(hit(), "  ", "ifrc");
    expect(p).not.toHaveProperty("impact");
    expect(p).not.toHaveProperty("admin");
    expect(placeFromHit(hit(), undefined, "news")).not.toHaveProperty("impact");
  });
});

describe("placeArea", () => {
  const place = (kind: Place["kind"]): Place => ({ name: "X", country: "TH", lat: 13.75, lng: 100.49, kind, source: "research" });

  it("uses the hit's outline when it has one", () => {
    const sylhet = pickBest(fixture("sylhet"), "BD", "Sylhet Division")!;
    const area = placeArea(placeFromHit(sylhet, undefined, "ifrc"), sylhet);
    expect(area).toEqual({ kind: "place", geometry: sylhet.area });
  });

  it("otherwise draws a circle sized by kind", () => {
    for (const kind of ["city", "town", "district", "region", "site"] as const) {
      const area = placeArea(place(kind), hit({ kind }));
      expect(area.kind).toBe("place");
      expect(area.geometry.type).toBe("Polygon");
      const [lng, lat] = (area.geometry as { coordinates: number[][][] }).coordinates[0][0];
      expect(haversineKm({ lat: 13.75, lng: 100.49 }, { lat, lng })).toBeCloseTo(PLACE_RADIUS_KM[kind], 0);
      expect(pointInGeometry(100.49, 13.75, area.geometry)).toBe(true);
    }
  });

  it("works for places that never had a hit", () => {
    const area = placeArea(place("town"), null);
    expect(area.geometry).toEqual(circlePolygon(13.75, 100.49, PLACE_RADIUS_KM.town));
    expect(placeArea(place("city")).geometry).toEqual(circlePolygon(13.75, 100.49, PLACE_RADIUS_KM.city));
  });
});
