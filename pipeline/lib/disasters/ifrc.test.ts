import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCountryConfig, loadGlobeFeatures } from "../countries";
import type { FetchDeps } from "../googlenews";
import { USER_AGENT } from "../googlenews";
import { buildResolver } from "../resolve";
import { countryCentroid, loadCountryShapes } from "./geo";
import type { Place, SourceEvent } from "./types";
import {
  latestReport,
  APPEALS_URL,
  DETAIL_GAP_MS,
  DISTRICT_BATCH,
  GO_API,
  MAX_COUNTRY_LOOKUPS,
  MAX_DETAIL_FETCHES,
  MAX_PLACES,
  SUMMARY_MAX,
  TARGET_LABEL,
  WINDOW_DAYS,
  appealCountry,
  countryCode,
  countryPage,
  decodeEntities,
  displayName,
  districtAliases,
  districtCentre,
  districtPlaces,
  districtsByIdUrl,
  districtsOfCountryUrl,
  dropHeading,
  dropTrailingDate,
  dtypeToType,
  emergencyPage,
  emptyExtras,
  eventFigures,
  eventUrl,
  extrasFromEvent,
  extrasFromPrevious,
  fallbackExtras,
  fetchAppeals,
  fetchCountryDistricts,
  fetchDistrictsById,
  fetchIfrc,
  findPrevious,
  formatValue,
  getJson,
  groupAppeals,
  hazardName,
  isCurrent,
  isPreparation,
  listProblem,
  loadExtras,
  locate,
  matchDistricts,
  meanPoint,
  naturalType,
  opening,
  operationPage,
  operationTitle,
  orderCountries,
  pacer,
  parseAppeal,
  parseAppealList,
  parseCountry,
  parseDistricts,
  parseEvent,
  prioritise,
  revisionOf,
  selectOperations,
  severityOf,
  severityText,
  stripHtml,
  summaryOf,
  targetFigure,
  tidyTitle,
  toAppealRef,
  toSourceEvent,
  typeFromName,
  type GoAppeal,
  type GoDistrict,
  type Operation,
} from "./ifrc";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Reads a trimmed real IFRC GO response saved under fixtures/. */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
}

/** The time the fixtures were fetched. */
const NOW = "2026-10-19T22:00:00.000Z";

const APPEALS = fixture("ifrc-appeals.json") as { results: Record<string, unknown>[] };
const EVENT_IDS = [8073, 8055, 8057, 8038, 8110, 8101, 7990, 7993, 8027] as const;
const EVENTS: Record<string, unknown> = Object.fromEntries(EVENT_IDS.map((id) => [String(id), fixture(`ifrc-event-${id}.json`)]));
const NOT_FOUND = fixture("ifrc-event-404.json");
const DISTRICTS_BY_ID = fixture("ifrc-districts-ids.json") as { results: Record<string, unknown>[] };
const COUNTRY_DISTRICTS: Record<string, unknown> = {
  COG: fixture("ifrc-districts-cog.json"),
  ZWE: fixture("ifrc-districts-zwe.json"),
  GNB: fixture("ifrc-districts-gnb.json"),
  CPV: fixture("ifrc-districts-cpv.json"), // Cabo Verde: not drawn on the globe
  XKX: fixture("ifrc-districts-xkx.json"), // Kosovo: XKX in GO, KOS on the globe
};

const shapes = loadCountryShapes();
const resolve = buildResolver(loadGlobeFeatures(), loadCountryConfig());

/** The parsed real appeal with this code. */
function appeal(code: string): GoAppeal {
  const row = APPEALS.results.find((r) => r.code === code);
  const a = parseAppeal(row);
  if (!a) throw new Error(`no fixture appeal ${code}`);
  return a;
}

/** A hand-made appeal for edge cases. */
function makeAppeal(over: Partial<GoAppeal> = {}): GoAppeal {
  return {
    code: "MDRXX001",
    name: "Testland - Floods",
    kind: "DREF",
    dtype: "Flood",
    requested: 100_000,
    funded: 50_000,
    people: 5_000,
    start: "2026-10-01T00:00:00.000Z",
    end: "2027-03-31T00:00:00.000Z",
    event: 9001,
    country: { iso: "TH", iso3: "THA", id: 77, name: "Thailand" },
    eventInfo: { name: "THA: Flood - 10-2026 - Chiang Mai Floods", severity: "Yellow", updatedAt: "2026-10-02T10:00:00.000000Z" },
    ...over,
  };
}

function makeOp(appeals: GoAppeal[], over: Partial<Operation> = {}): Operation {
  const event = appeals[0]?.event ?? null;
  return { key: event !== null ? String(event) : `appeal-${appeals[0]?.code}`, event, appeals, type: "flood", ...over };
}

function district(over: Partial<GoDistrict> = {}): GoDistrict {
  return { id: 1, name: "Chiang Mai", iso: "TH", iso3: "THA", lat: 18.79, lng: 98.98, ...over };
}

/** A route answers with a JSON body, an HTTP status, or a thrown error. */
type Answer = unknown | { status: number } | Error;

function isStatus(x: unknown): x is { status: number } {
  return !!x && typeof x === "object" && "status" in x && Object.keys(x).length === 1;
}

/**
 * A stand-in for the GO API serving the fixtures: the appeal list, the
 * emergency records (404 for the rest, as GO answers for non-public ones),
 * district lookups by id (filtered, as GO does) and by country. `over`
 * replaces the answer for a URL.
 */
function goServer(over: Record<string, Answer> = {}): (url: string) => Answer {
  return (url) => {
    if (url in over) return over[url];
    if (url === APPEALS_URL) return APPEALS;
    let m = /\/event\/(\d+)\/$/.exec(url);
    if (m) return EVENTS[m[1]] ?? { status: 404 };
    m = /\/district\/\?id__in=([\d,]+)&limit=\d+$/.exec(url);
    if (m) {
      const ids = new Set(m[1].split(",").map(Number));
      return { count: ids.size, next: null, previous: null, results: DISTRICTS_BY_ID.results.filter((r) => ids.has(r.id as number)) };
    }
    m = /\/district\/\?country__iso3=([A-Z]{3})&limit=500$/.exec(url);
    if (m) return COUNTRY_DISTRICTS[m[1]] ?? { count: 0, next: null, previous: null, results: [] };
    return { status: 404 };
  };
}

/** Fake FetchDeps answering from a handler; checks every request carries the user agent and a timeout. */
function fakeDeps(handler: (url: string) => Answer = goServer()) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(USER_AGENT);
    expect(headers["Accept-Language"]).toBe("en");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const answer = handler(url);
    if (answer instanceof Error) throw answer;
    if (isStatus(answer)) return new Response(answer.status === 404 ? JSON.stringify(NOT_FOUND) : "error", { status: answer.status });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  const sleep = vi.fn(async (ms: number) => void ms);
  const log = vi.fn((msg: string) => void msg);
  const deps: FetchDeps = { fetch: fetch as unknown as typeof globalThis.fetch, sleep, log };
  return { deps, fetch, sleep, log, calls };
}

const noPace = async () => {};

// ---------------------------------------------------------------------------
// Small helpers and network
// ---------------------------------------------------------------------------

describe("formatValue", () => {
  it("adds thousands separators to plain digits only", () => {
    expect(formatValue("84270")).toBe("84,270");
    expect(formatValue(" 337 ")).toBe("337");
    expect(formatValue("11,890,000")).toBe("11,890,000");
    expect(formatValue("about 2000")).toBe("about 2000");
  });
});

describe("getJson", () => {
  it("returns the parsed body", async () => {
    const { deps, sleep } = fakeDeps(() => ({ ok: 1 }));
    expect(await getJson(`${GO_API}/x/`, deps, 100)).toEqual({ ok: true, body: { ok: 1 } });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats a 404 as an answer (not public) and does not retry", async () => {
    const { deps, calls, sleep, log } = fakeDeps(() => ({ status: 404 }));
    expect(await getJson(eventUrl(8115), deps, 100)).toEqual({ ok: false, missing: true });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(/not public/);
  });

  it("retries once after the delay on a bad status", async () => {
    let n = 0;
    const { deps, sleep } = fakeDeps(() => (++n === 1 ? { status: 503 } : { ok: 2 }));
    expect(await getJson(`${GO_API}/x/`, deps, 1234)).toEqual({ ok: true, body: { ok: 2 } });
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it("gives up after two failures without throwing", async () => {
    const { deps, calls, log } = fakeDeps(() => new Error("socket hang up"));
    expect(await getJson(`${GO_API}/x/`, deps, 10)).toEqual({ ok: false, missing: false });
    expect(calls).toHaveLength(2);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/attempt 2 failed: socket hang up/);
  });

  it("counts a body that is not JSON as a failure", async () => {
    const { deps } = fakeDeps();
    deps.fetch = vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 })) as never;
    expect(await getJson(`${GO_API}/x/`, deps, 10)).toEqual({ ok: false, missing: false });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("pacer", () => {
  it("waits before every call but the first", async () => {
    const { deps, sleep } = fakeDeps();
    const pace = pacer(deps, DETAIL_GAP_MS);
    await pace();
    expect(sleep).not.toHaveBeenCalled();
    await pace();
    await pace();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(DETAIL_GAP_MS);
  });
});

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

describe("parseCountry", () => {
  it("reads a GO country", () => {
    expect(parseCountry({ iso: "np", iso3: "NPL", id: 123, name: "Nepal" })).toEqual({ iso: "NP", iso3: "NPL", id: 123, name: "Nepal" });
  });

  it("returns null for GO's IFRC pseudo-country and non-objects", () => {
    expect(parseCountry({ iso: null, iso3: null, id: 289, name: "IFRC" })).toBeNull();
    expect(parseCountry(null)).toBeNull();
    expect(parseCountry("NP")).toBeNull();
  });
});

describe("parseAppeal", () => {
  it("reads a real Emergency Appeal", () => {
    expect(appeal("MDRNP022")).toEqual({
      code: "MDRNP022",
      name: "Rasuwa Flash Flood",
      kind: "Emergency Appeal",
      dtype: "Flood",
      requested: 18_000_000,
      funded: expect.any(Number),
      people: 28_000,
      start: "2026-08-26T00:00:00.000Z",
      end: "2028-08-31T00:00:00.000Z",
      event: 8073,
      country: { iso: "NP", iso3: "NPL", id: 123, name: "Nepal" },
      eventInfo: { name: "Nepal: Rasuwa Flash Flood, 2026", severity: "Orange", updatedAt: "2026-10-13T12:19:47.651852Z" },
    });
  });

  it("takes the emergency from event_details when event is null", () => {
    const a = appeal("MDRCG030");
    expect(a.event).toBe(8115);
    expect(a.eventInfo?.name).toMatch(/^COG: Flood - 10-2026 - Floods in the department of likouala/);
    expect(a.eventInfo?.severity).toBe("Yellow");
  });

  it("has no country for appeals run from Geneva", () => {
    const a = appeal("MDRID029");
    expect(a.country).toBeNull();
    expect(a.event).toBeNull();
    expect(a.eventInfo).toBeNull();
    expect(a.requested).toBe(0);
  });

  it("rejects rows without a code, name or dates", () => {
    const row = APPEALS.results[0];
    expect(parseAppeal({ ...row, code: "" })).toBeNull();
    expect(parseAppeal({ ...row, name: null })).toBeNull();
    expect(parseAppeal({ ...row, end_date: "soon" })).toBeNull();
    expect(parseAppeal("MDRNP022")).toBeNull();
  });

  it("defaults missing amounts and kind", () => {
    const row = { code: "MDRZZ001", name: "Zed", start_date: "2026-10-01", end_date: "2027-01-01" };
    expect(parseAppeal(row)).toMatchObject({ kind: "DREF", dtype: "", requested: 0, funded: 0, people: null, event: null, country: null, eventInfo: null });
  });
});

describe("parseAppealList", () => {
  it("reads the real list", () => {
    const list = parseAppealList(APPEALS);
    expect(list?.appeals).toHaveLength(APPEALS.results.length);
    expect(list?.next).toBeNull();
  });

  it("follows next only on the GO API and rejects non-lists", () => {
    expect(parseAppealList({ results: [], next: `${GO_API}/appeal/?offset=1000` })?.next).toBe(`${GO_API}/appeal/?offset=1000`);
    expect(parseAppealList({ errors: {} })).toBeNull();
    expect(parseAppealList([])).toBeNull();
  });

  it("rejects a page whose next link leads off the GO API, since the list could not be read whole", () => {
    expect(parseAppealList({ results: APPEALS.results.slice(0, 2), next: "https://evil.example/appeal/" })).toBeNull();
  });

  it("upgrades an http next link on GO's host and reports GO's count and the raw rows", () => {
    const list = parseAppealList({ count: 7, results: [...APPEALS.results.slice(0, 2), { code: "" }], next: "http://goadmin.ifrc.org/api/v2/appeal/?limit=3&offset=3" })!;
    expect(list.next).toBe(`${GO_API}/appeal/?limit=3&offset=3`);
    expect(list).toMatchObject({ total: 7, rows: 3 });
    expect(list.appeals).toHaveLength(2);
    expect(parseAppealList(APPEALS)).toMatchObject({ total: APPEALS.results.length, rows: APPEALS.results.length });
  });
});

describe("listProblem", () => {
  it("accepts a whole list", () => {
    expect(listProblem(null, 362, 362)).toBeNull();
    expect(listProblem(null, 3, null)).toBeNull();
  });

  it("names unread pages, an empty list and missing rows", () => {
    expect(listProblem(`${GO_API}/appeal/?offset=5000`, 5000, 6000)).toMatch(/pages/);
    expect(listProblem(null, 0, 0)).toMatch(/empty/);
    expect(listProblem(null, 250, 362)).toBe("only 250 of 362 rows");
  });
});

describe("fetchAppeals", () => {
  it("reads every active appeal", async () => {
    const { deps, calls } = fakeDeps();
    expect(await fetchAppeals(deps)).toHaveLength(APPEALS.results.length);
    expect(calls).toEqual([APPEALS_URL]);
  });

  it("follows pages", async () => {
    const page2 = `${GO_API}/appeal/?limit=1000&offset=1000&status=0`;
    const first = { results: APPEALS.results.slice(0, 2), next: page2 };
    const second = { results: APPEALS.results.slice(2, 3), next: null };
    const { deps, calls } = fakeDeps(goServer({ [APPEALS_URL]: first, [page2]: second }));
    expect((await fetchAppeals(deps))?.map((a) => a.code)).toEqual(["MDRNP022", "MDRCO036", "MDRPH060"]);
    expect(calls).toEqual([APPEALS_URL, page2]);
  });

  it("returns null when a page fails or is not a list", async () => {
    expect(await fetchAppeals(fakeDeps(goServer({ [APPEALS_URL]: { status: 500 } })).deps)).toBeNull();
    expect(await fetchAppeals(fakeDeps(goServer({ [APPEALS_URL]: { detail: "throttled" } })).deps)).toBeNull();
  });

  it("returns null rather than a partial or empty list", async () => {
    const empty = fakeDeps(goServer({ [APPEALS_URL]: { count: 0, next: null, previous: null, results: [] } }));
    expect(await fetchAppeals(empty.deps)).toBeNull();
    expect(empty.log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/empty; previous data kept/);
    const short = { count: APPEALS.results.length + 50, next: null, results: APPEALS.results };
    expect(await fetchAppeals(fakeDeps(goServer({ [APPEALS_URL]: short })).deps)).toBeNull();
    const offsite = { results: APPEALS.results.slice(0, 2), next: "https://mirror.example/api/v2/appeal/?offset=2" };
    expect(await fetchAppeals(fakeDeps(goServer({ [APPEALS_URL]: offsite })).deps)).toBeNull();
  });

  it("returns null when there are more pages than it reads", async () => {
    const page = (n: number) => `${GO_API}/appeal/?limit=1&offset=${n}&status=0`;
    const pages: Record<string, unknown> = { [APPEALS_URL]: { results: APPEALS.results.slice(0, 1), next: page(1) } };
    for (let n = 1; n < 10; n++) pages[page(n)] = { results: APPEALS.results.slice(n, n + 1), next: page(n + 1) };
    const { deps, calls } = fakeDeps(goServer(pages));
    expect(await fetchAppeals(deps)).toBeNull();
    expect(calls).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Which appeals count
// ---------------------------------------------------------------------------

describe("typeFromName", () => {
  it("finds the hazard a title names", () => {
    expect(typeFromName("Zimbabwe Hailstorms")).toBe("storm");
    expect(typeFromName("Guinea-Bissau - Windstorm")).toBe("storm");
    expect(typeFromName("Indonesia - Earthquake")).toBe("earthquake");
    expect(typeFromName("Nigeria - Floods imminent")).toBe("flood");
    expect(typeFromName("Sierra Leone: Windstorm and Fire")).toBe("storm");
    expect(typeFromName("Mongolia - Dzud")).toBe("coldwave");
    expect(typeFromName("Chad - Dust storm")).toBe("dust");
    expect(typeFromName("Vanuatu - Volcanic Ash")).toBe("volcano");
  });

  it("reads the wordings GO uses under Other for winters, rains and snow", () => {
    expect(typeFromName("Serbia - Extreme Winter Condition")).toBe("coldwave"); // a real Other appeal (MDRRS016)
    expect(typeFromName("Mongolia - Harsh winter")).toBe("coldwave");
    expect(typeFromName("Kenya - Heavy Rains")).toBe("flood");
    expect(typeFromName("Niger - Torrential rainfall")).toBe("flood");
    expect(typeFromName("Nepal - Heavy Rains and Landslides")).toBe("landslide");
    expect(typeFromName("Afghanistan - Heavy Snowfall")).toBe("storm");
    expect(typeFromName("Gaza - Winter conditions and displacement")).toBeNull();
  });

  it("ignores non-natural crises and plain fires", () => {
    expect(typeFromName("Zambia - Measles")).toBeNull();
    expect(typeFromName("Comoros Cholera sEAP")).toBeNull();
    expect(typeFromName("Post-flood cholera outbreak")).toBeNull();
    expect(typeFromName("Sao Tome and Principe - Election Readiness")).toBeNull();
    expect(typeFromName("Malaysia Sandakan Fire")).toBeNull();
  });
});

describe("dtypeToType", () => {
  it("maps IFRC's natural disaster types", () => {
    expect(dtypeToType("Flood", "x")).toBe("flood");
    expect(dtypeToType("Pluvial/Flash Flood", "x")).toBe("flood");
    expect(dtypeToType("Flash Flood", "x")).toBe("flood");
    expect(dtypeToType("Cyclone", "x")).toBe("cyclone");
    expect(dtypeToType("Severe Local Storm", "x")).toBe("storm");
    expect(dtypeToType("Earthquake", "x")).toBe("earthquake");
    expect(dtypeToType("Tsunami", "x")).toBe("tsunami");
    expect(dtypeToType("Volcanic Eruption", "x")).toBe("volcano");
    expect(dtypeToType("Drought", "x")).toBe("drought");
    expect(dtypeToType("Heat Wave", "x")).toBe("heatwave");
    expect(dtypeToType("cold wave", "x")).toBe("coldwave");
    expect(dtypeToType("Landslide", "x")).toBe("landslide");
  });

  it("reads Storm Surge as a cyclone unless the title is a local storm", () => {
    expect(dtypeToType("Storm Surge", "Djibouti - Storm Surge")).toBe("cyclone");
    expect(dtypeToType("Storm Surge", "Armenia Hail storm")).toBe("storm");
    expect(dtypeToType("Storm Surge", "Windstorm and Tropical Storm Ana")).toBe("cyclone");
  });

  it("counts Fire only as wildfire, and Other only by its title", () => {
    expect(dtypeToType("Fire", "Tunisia - Wildfires")).toBe("wildfire");
    expect(dtypeToType("Fire", "Chile - Forest fires")).toBe("wildfire");
    expect(dtypeToType("Fire", "Malaysia Sandakan Fire")).toBeNull();
    expect(dtypeToType("Other", "Zimbabwe Hailstorms")).toBe("storm");
    expect(dtypeToType("Other", "Zambia - Measles")).toBeNull();
  });

  it("skips crises that are not natural disasters", () => {
    for (const d of ["Epidemic", "Population Movement", "Complex Emergency", "Civil Unrest", "Food Insecurity", "Insect Infestation", "Transport Accident", "Chemical Emergency", "Biological Emergency", ""]) {
      expect(dtypeToType(d, "Floods everywhere")).toBeNull();
    }
  });
});

describe("isPreparation", () => {
  it("flags early-action protocols, readiness and imminent DREFs", () => {
    expect(isPreparation("Nigeria - Drought sEAP", "drought")).toBe(true);
    expect(isPreparation("Honduras - Drought - EAP", "drought")).toBe(true);
    expect(isPreparation("Tajikistan - Cold Wave (EAP2022TJ02)", "coldwave")).toBe(true);
    expect(isPreparation("Central African Republic - Ebola Virus Disease Readiness", null)).toBe(true);
    expect(isPreparation("Ecuador - Floods - Imminent", "flood")).toBe(true);
  });

  it("keeps responses, and imminent cyclones", () => {
    expect(isPreparation("Rasuwa Flash Flood", "flood")).toBe(false);
    expect(isPreparation("Mozambique - Tropical Cyclone imminent", "cyclone")).toBe(false);
    expect(isPreparation("Leap year flood", "flood")).toBe(false);
  });
});

describe("naturalType", () => {
  it("combines the type and the preparation rule", () => {
    expect(naturalType(appeal("MDRZW030"))).toBe("storm");
    expect(naturalType(appeal("MDRTN013"))).toBe("wildfire");
    expect(naturalType(appeal("MDRNG044"))).toBeNull();
    expect(naturalType(appeal("MDREC032"))).toBeNull();
    expect(naturalType(appeal("MDRBD041"))).toBeNull();
  });
});

describe("isCurrent", () => {
  it("needs the appeal running and begun within the window", () => {
    const day = 86_400_000;
    const at = (d: number) => new Date(Date.parse(NOW) + d * day).toISOString();
    expect(isCurrent({ start: at(-10), end: at(10) }, NOW)).toBe(true);
    expect(isCurrent({ start: at(-WINDOW_DAYS), end: at(10) }, NOW)).toBe(true);
    expect(isCurrent({ start: at(-WINDOW_DAYS - 1), end: at(10) }, NOW)).toBe(false);
    expect(isCurrent({ start: at(-10), end: at(-1) }, NOW)).toBe(false);
    expect(isCurrent({ start: at(1), end: at(100) }, NOW)).toBe(true);
    expect(isCurrent({ start: at(5), end: at(100) }, NOW)).toBe(false);
  });

  it("matches the real appeals", () => {
    expect(isCurrent(appeal("MDRVE015"), NOW)).toBe(true);
    expect(isCurrent(appeal("MDRAM018"), NOW)).toBe(false);
    expect(isCurrent(appeal("MDRS10005"), NOW)).toBe(false);
  });
});

describe("groupAppeals", () => {
  it("groups by emergency, largest appeal first, and keys lone appeals by code", () => {
    const small = makeAppeal({ code: "MDRXX001", requested: 100 });
    const big = makeAppeal({ code: "MDRXX002", requested: 900, kind: "Emergency Appeal" });
    const lone = makeAppeal({ code: "MDRYY003", event: null, eventInfo: null });
    const groups = groupAppeals([small, lone, big, small]);
    expect(groups.map((g) => g.key)).toEqual(["9001", "appeal-MDRYY003"]);
    expect(groups[0].appeals.map((a) => a.code)).toEqual(["MDRXX002", "MDRXX001"]);
    expect(groups[1]).toEqual({ key: "appeal-MDRYY003", event: null, appeals: [lone] });
  });
});

describe("selectOperations", () => {
  const ops = selectOperations(parseAppealList(APPEALS)!.appeals, NOW);

  it("keeps natural disasters happening now, from the real list", () => {
    expect(ops.map((o) => `${o.key}:${o.type}`).sort()).toEqual(
      [
        "7990:earthquake",
        "7993:flood",
        "8014:flood",
        "8027:wildfire",
        "8034:cyclone",
        "8038:wildfire",
        "8055:earthquake",
        "8057:flood",
        "8073:flood",
        "8101:storm",
        "8108:storm",
        "8110:earthquake",
        "8115:flood",
        "appeal-MDRID029:earthquake",
      ].sort(),
    );
  });

  it("leads with the natural appeal and drops appeals that ended", () => {
    const cholera = makeAppeal({ code: "MDRXX009", dtype: "Epidemic", name: "Testland Cholera", requested: 5_000_000 });
    const flood = makeAppeal({ code: "MDRXX001" });
    const ended = makeAppeal({ code: "MDRXX002", end: "2026-10-01T00:00:00.000Z", requested: 9_000_000 });
    const [op] = selectOperations([cholera, flood, ended], NOW);
    expect(op.appeals.map((a) => a.code)).toEqual(["MDRXX001", "MDRXX009"]);
    expect(op.type).toBe("flood");
  });

  it("skips a group whose only natural appeal is old", () => {
    expect(selectOperations([makeAppeal({ start: "2026-01-01T00:00:00.000Z" })], NOW)).toEqual([]);
  });
});

describe("prioritise", () => {
  it("puts Emergency Appeals first, then the newest", () => {
    const a = makeOp([makeAppeal({ event: 1, start: "2026-10-10T00:00:00.000Z" })]);
    const b = makeOp([makeAppeal({ event: 2, start: "2026-09-01T00:00:00.000Z", kind: "Emergency Appeal" })]);
    const c = makeOp([makeAppeal({ event: 3, start: "2026-10-15T00:00:00.000Z" })]);
    expect(prioritise([a, b, c]).map((o) => o.key)).toEqual(["2", "3", "1"]);
  });
});

// ---------------------------------------------------------------------------
// Emergency records and districts
// ---------------------------------------------------------------------------

describe("parseEvent", () => {
  it("reads the parts of a real record it uses", () => {
    const ev = parseEvent(EVENTS["8073"])!;
    expect(ev).toMatchObject({
      id: 8073,
      name: "Nepal: Rasuwa Flash Flood, 2026",
      countries: [{ iso: "NP", iso3: "NPL", id: 123, name: "Nepal" }],
      districts: [{ id: 3527, name: "Bagmati" }],
      glide: "FF-2026-000162-NPL",
      started: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-10-13T12:19:47.651852Z",
      severity: "Orange",
      affected: 84_270,
    });
    expect(ev.keyFigures[0]).toEqual({ number: "1451", deck: "Confirmed Dead", source: "NDRRMA" });
    expect(Object.keys(ev)).not.toContain("field_reports");
    expect(Object.keys(ev)).not.toContain("contacts");
  });

  it("leaves out an empty GLIDE and figures without a number", () => {
    const ev = parseEvent({ ...(EVENTS["8057"] as object), key_figures: [{ number: "", deck: "Dead" }, { number: 12, deck: "Injured", source: null }] })!;
    expect(ev.glide).toBeUndefined();
    expect(ev.keyFigures).toEqual([{ number: "12", deck: "Injured", source: "" }]);
  });

  it("returns null for a 404 body or garbage", () => {
    expect(parseEvent(NOT_FOUND)).toBeNull();
    expect(parseEvent([])).toBeNull();
    expect(parseEvent({ id: "8073", name: "x" })).toBeNull();
  });
});

describe("parseDistricts", () => {
  it("reads real district rows with their centroids", () => {
    const rows = parseDistricts(DISTRICTS_BY_ID)!;
    expect(rows).toHaveLength(DISTRICTS_BY_ID.results.length);
    expect(rows.find((d) => d.id === 3527)).toEqual({ id: 3527, name: "Bagmati", iso: "NP", iso3: "NPL", lat: 27.6786520968197, lng: 85.47056422193907 });
  });

  it("skips rows without a usable centroid and rejects non-lists", () => {
    const rows = [
      { id: 1, name: "A", centroid: null },
      { id: 2, name: "B", centroid: { type: "Point", coordinates: [200, 10] } },
      { id: 3, name: "C", centroid: { type: "Point", coordinates: [10, 20] }, country_iso: "th" },
    ];
    expect(parseDistricts({ results: rows })).toEqual([{ id: 3, name: "C", iso: "TH", iso3: null, lat: 20, lng: 10 }]);
    expect(parseDistricts({ errors: {} })).toBeNull();
  });
});

describe("URLs", () => {
  it("builds GO API and site URLs", () => {
    expect(eventUrl(8073)).toBe("https://goadmin.ifrc.org/api/v2/event/8073/");
    expect(districtsByIdUrl([1, 2])).toBe("https://goadmin.ifrc.org/api/v2/district/?id__in=1,2&limit=2");
    expect(districtsOfCountryUrl("ZWE")).toBe("https://goadmin.ifrc.org/api/v2/district/?country__iso3=ZWE&limit=500");
    expect(emergencyPage(8073)).toBe("https://go.ifrc.org/emergencies/8073");
    expect(countryPage(123)).toBe("https://go.ifrc.org/countries/123");
  });
});

describe("fetchDistrictsById", () => {
  it("asks in batches and keeps only the asked-for ids", async () => {
    const ids = Array.from({ length: DISTRICT_BATCH + 5 }, (_, i) => i + 1).concat([3527, 3527]);
    const everything = { results: DISTRICTS_BY_ID.results };
    const { deps, calls } = fakeDeps(() => everything); // as if GO ignored the filter
    const { found, complete } = await fetchDistrictsById(ids, deps, noPace);
    expect(calls).toHaveLength(2);
    expect(complete).toBe(true);
    expect([...found.keys()]).toEqual([3527]);
  });

  it("reports a failed batch", async () => {
    const { deps } = fakeDeps(() => ({ status: 500 }));
    const { found, complete } = await fetchDistrictsById([3527], deps, noPace);
    expect(found.size).toBe(0);
    expect(complete).toBe(false);
  });
});

describe("fetchCountryDistricts", () => {
  it("reads one country's districts and drops other countries' rows", async () => {
    const zwe = COUNTRY_DISTRICTS.ZWE as { results: unknown[] };
    const mixed = { results: [...zwe.results, ...(COUNTRY_DISTRICTS.COG as { results: unknown[] }).results] };
    const { deps } = fakeDeps(() => mixed);
    const rows = await fetchCountryDistricts("zwe", deps, noPace);
    expect(rows).toHaveLength(10);
    expect(rows?.every((d) => d.iso3 === "ZWE")).toBe(true);
  });

  it("returns null on failure", async () => {
    expect(await fetchCountryDistricts("ZWE", fakeDeps(() => ({ status: 502 })).deps, noPace)).toBeNull();
  });
});

describe("matchDistricts", () => {
  const cog = parseDistricts(COUNTRY_DISTRICTS.COG)!;
  const zwe = parseDistricts(COUNTRY_DISTRICTS.ZWE)!;

  it("finds districts named in real titles", () => {
    expect(matchDistricts(["Congo Likouala Flood", "COG: Flood - 10-2026 - Floods in the department of likouala, districts of Epéna and Impfondo"], cog, ["Congo"]).map((d) => d.name)).toEqual(["Likouala"]);
    expect(matchDistricts(["ZWE: Other - 10-2026 - Masvingo Hailstorm"], zwe, ["Zimbabwe"]).map((d) => d.name)).toEqual(["Masvingo"]);
  });

  it("never matches the country's own name, generic names or parts of words", () => {
    const pa = [district({ id: 1, name: "Panama" }), district({ id: 2, name: "Central" }), district({ id: 3, name: "Bocas del Toro" }), district({ id: 4, name: "Oro" })];
    expect(matchDistricts(["Panama Earthquake - 2026", "Central Panama floods"], pa, ["Panama", "Panamá"])).toEqual([]);
    expect(matchDistricts(["PAN: Flood - 08-2026 - Bocas del Toro Floods"], pa, ["Panama"]).map((d) => d.id)).toEqual([3]);
    expect(matchDistricts(["Floods in Oroville"], [district({ name: "Orov" })], [])).toEqual([]);
  });

  it("matches a district GO names in two languages by either name", () => {
    const xkx = parseDistricts(COUNTRY_DISTRICTS.XKX)!;
    expect(matchDistricts(["Kosovo - Floods in Pejë and Prizren"], xkx, ["Kosovo"]).map((d) => d.name)).toEqual(["Pejë / Pec", "Prizren / Prizren"]);
    expect(matchDistricts(["Floods in Pec"], xkx, ["Kosovo"])).toEqual([]); // "Pec" is under 4 letters
  });

  it("matches a district by its name without administrative words (real GO names)", () => {
    const civ = [district({ id: 1, name: "District Autonome D'Abidjan", iso: "CI", iso3: "CIV" }), district({ id: 2, name: "San Pedro", iso: "CI", iso3: "CIV" })];
    expect(matchDistricts(["CIV: Flood - 06-2026 - Abidjan Floods"], civ, ["Côte d'Ivoire"]).map((d) => d.id)).toEqual([1]);
    const mmr = [district({ id: 3, name: "Chin State" }), district({ id: 4, name: "Bago Region (East)" }), district({ id: 5, name: "Mon" })];
    expect(matchDistricts(["Myanmar - Chin floods", "Floods in Mon State"], mmr, ["Myanmar"]).map((d) => d.id)).toEqual([3]);
    const za = [district({ id: 6, name: "Free State" })];
    expect(matchDistricts(["South Africa - Free State floods"], za, ["South Africa"]).map((d) => d.id)).toEqual([6]);
    expect(matchDistricts(["South Africa - toll-free line for flood victims"], za, ["South Africa"])).toEqual([]);
  });
});

describe("districtAliases", () => {
  it("lists each language's name, the name without admin words, and the bracketed name", () => {
    expect(districtAliases("District Autonome D'Abidjan")).toEqual(["district autonome d abidjan", "abidjan"]);
    expect(districtAliases("Pejë / Pec")).toEqual(["peje", "pec"]);
    expect(districtAliases("Region I (Ilocos Region)")).toContain("ilocos");
    expect(districtAliases("Bago Region (East)")).toEqual(["bago region east", "bago region", "bago", "east"]);
    expect(districtAliases("Jalal-Abad")).toEqual(["jalal abad"]);
  });
});

// ---------------------------------------------------------------------------
// Countries and places
// ---------------------------------------------------------------------------

describe("countryCode", () => {
  it("resolves ISO3 first, then an ISO2 the globe has", () => {
    expect(countryCode({ iso: "NP", iso3: "NPL" }, resolve, shapes)).toBe("NP");
    expect(countryCode({ iso: "NP", iso3: "XXX" }, resolve, shapes)).toBe("NP");
    expect(countryCode({ iso: "QQ", iso3: null }, resolve, shapes)).toBeUndefined();
  });
});

describe("appealCountry", () => {
  it("uses the appeal's country", () => {
    expect(appealCountry(appeal("MDRCG030"), resolve, shapes)).toBe("CG");
  });

  it("falls back to the ISO2 in the appeal code for appeals run from Geneva", () => {
    expect(appealCountry(appeal("MDRID029"), resolve, shapes)).toBe("ID");
    expect(appealCountry(appeal("MDRGE021"), resolve, shapes)).toBe("GE");
  });

  it("falls back to leading words of the name", () => {
    expect(appealCountry({ code: "MDRS10005", name: "Malawi - Cyclone Chido", country: null }, resolve, shapes)).toBe("MW");
    expect(appealCountry({ code: "X", name: "Congo Likouala Flood", country: null }, resolve, shapes)).toBe("CG");
    expect(appealCountry({ code: "X", name: "Africa - Cyclone Chido", country: null }, resolve, shapes)).toBeUndefined();
  });
});

describe("orderCountries", () => {
  it("lists each code once, appeals first", () => {
    expect(orderCountries(["MZ", undefined, "MW"], ["MW", "ZW", "MZ"])).toEqual(["MZ", "MW", "ZW"]);
  });
});

describe("displayName", () => {
  it("uses the globe's short name unless it is abbreviated", () => {
    expect(displayName("NP", shapes)).toBe("Nepal");
    expect(displayName("CD", shapes)).toBe("Democratic Republic of the Congo");
    expect(displayName("QQ", shapes)).toBeUndefined();
  });
});

describe("districtPlaces", () => {
  it("makes rounded district places in the district's country", () => {
    expect(districtPlaces([district({ lat: 18.787654321, lng: 98.993456789 })], undefined, resolve, shapes)).toEqual([
      { name: "Chiang Mai", country: "TH", lat: 18.7877, lng: 98.9935, kind: "district", source: "ifrc" },
    ]);
  });

  it("falls back to the operation's country, skips repeats and caps the list", () => {
    const odd = district({ iso: null, iso3: null });
    expect(districtPlaces([odd], "TH", resolve, shapes)[0].country).toBe("TH");
    expect(districtPlaces([odd], undefined, resolve, shapes)).toEqual([]);
    expect(districtPlaces([district(), district({ id: 2 })], undefined, resolve, shapes)).toHaveLength(1);
    const many = Array.from({ length: MAX_PLACES + 10 }, (_, i) => district({ id: i, name: `D${i}` }));
    expect(districtPlaces(many, undefined, resolve, shapes)).toHaveLength(MAX_PLACES);
  });
});

describe("meanPoint", () => {
  it("averages points on the sphere", () => {
    const m = meanPoint([
      { lat: 10, lng: 20 },
      { lat: 10, lng: 22 },
    ]);
    expect(m.lng).toBeCloseTo(21, 3);
    expect(m.lat).toBeGreaterThan(10);
    expect(m.lat).toBeCloseTo(10, 1);
  });

  it("is safe across the antimeridian", () => {
    const m = meanPoint([
      { lat: -17, lng: 179 },
      { lat: -17, lng: -179 },
    ]);
    expect(Math.abs(m.lng)).toBeCloseTo(180, 3);
  });
});

describe("locate", () => {
  const places: Place[] = [{ name: "Bagmati", country: "NP", lat: 27.6787, lng: 85.4706, kind: "district", source: "ifrc" }];

  it("uses the districts' centre", () => {
    expect(locate(places, ["NP"], shapes)).toEqual({ lat: 27.6787, lng: 85.4706, precision: "area" });
  });

  it("falls back to the first known country's centre, else null", () => {
    expect(locate([], ["QQ", "NP"], shapes)).toEqual({ ...countryCentroid("NP", shapes)!, precision: "country" });
    expect(locate([], [], shapes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("decodeEntities", () => {
  it("decodes numeric, named and accented-letter entities", () => {
    expect(decodeEntities("Protecci&oacute;n &amp; r&aacute;fagas &#8211; &#x2014; &Eacute;quateur &ntilde; &nbsp;&quot;x&quot;")).toBe('Protección & ráfagas – — Équateur ñ  "x"');
    expect(decodeEntities("&amp;oacute; &bogus; &#0;")).toBe("&oacute; &bogus; &#0;");
  });
});

describe("stripHtml", () => {
  it("removes tags, images, scripts and the space before punctuation", () => {
    const html = '<p class="x"><span>approximately 9:15 AM</span>. The flood <img src="a.png">hit<br>( Timure )</p><script>alert(1)</script><style>p{}</style>';
    expect(stripHtml(html)).toBe("approximately 9:15 AM. The flood hit (Timure)");
  });
});

describe("dropHeading", () => {
  it("drops report headings before a sentence", () => {
    expect(dropHeading("1. Situation Overview On 11 July 2026, floods hit.")).toBe("On 11 July 2026, floods hit.");
    expect(dropHeading("Executive Summary On 13 July 2026 at 19:30, rain fell.")).toBe("On 13 July 2026 at 19:30, rain fell.");
    expect(dropHeading("2. Event Description The river rose.")).toBe("The river rose.");
  });

  it("keeps text that only starts with a heading word", () => {
    expect(dropHeading("Summary of the floods in May.")).toBe("Summary of the floods in May.");
    expect(dropHeading("A major flash flood struck.")).toBe("A major flash flood struck.");
  });

  it("drops only the number of a numbered paragraph that opens with a sentence", () => {
    expect(dropHeading("1. The Government of Nepal declared an emergency.")).toBe("The Government of Nepal declared an emergency.");
    expect(dropHeading("1. Heavy Rains Hit Kenya in May.")).toBe("Heavy Rains Hit Kenya in May.");
    expect(dropHeading("2. Event Description The river rose.")).toBe("The river rose.");
  });
});

describe("opening", () => {
  it("keeps short text and cuts long text at a sentence end", () => {
    expect(opening("Short.", 50)).toBe("Short.");
    const text = "First sentence here. Second sentence is here too. Third one runs on and on and on.";
    expect(opening(text, 60)).toBe("First sentence here. Second sentence is here too.");
  });

  it("does not take an abbreviation for a sentence end", () => {
    const text = "Alert from 6:00 p.m. for the coast. Then more words follow here to pass the limit.";
    expect(opening(text, 60)).toBe("Alert from 6:00 p.m. for the coast.");
  });

  it("does not cut after an abbreviation or an initial", () => {
    // From the real Liberia record: "...along the St. Paul River".
    const liberia = "Montserrado has a dense urban corridor. Settlements lie along the St. Paul River and the Du River near Monrovia.";
    expect(opening(liberia, 80)).toBe("Montserrado has a dense urban corridor.");
    expect(opening("Ash fell near Mt. Lewotobi and villages were cleared. Then more words follow here.", 60)).toBe("Ash fell near Mt. Lewotobi and villages were cleared.");
    expect(opening("Funding from the U.S. Agency came. Then more words follow here to pass it.", 40)).toBe("Funding from the U.S. Agency came.");
  });

  it("cuts at a word with an ellipsis when there is no early sentence end", () => {
    const out = opening("word ".repeat(200).trim(), 50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).not.toMatch(/\s…$/);
  });
});

describe("summaryOf", () => {
  it("makes a short plain summary from a real record", () => {
    const s = summaryOf((EVENTS["8073"] as { summary: string }).summary)!;
    expect(s.startsWith("A major flash flood struck Rasuwa district")).toBe(true);
    expect(s).toContain("9:15 AM. The flood");
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(s).not.toMatch(/<|&[a-z]+;/);
  });

  it("drops the heading of a real record and is undefined when empty", () => {
    expect(summaryOf("<p>1. Situation Overview On 11 July 2026, following intense rainfall, flash floods and mudflows affected the villages.</p>")).toBe(
      "On 11 July 2026, following intense rainfall, flash floods and mudflows affected the villages.",
    );
    expect(summaryOf('<p><img src="x.png"></p>')).toBeUndefined();
    expect(summaryOf("")).toBeUndefined();
  });
});

describe("dropTrailingDate", () => {
  it("drops trailing month-year, year and slash dates but keeps a month's year", () => {
    expect(dropTrailingDate("Liberia: Floods - 08-2026")).toBe("Liberia: Floods");
    expect(dropTrailingDate("Myanmar - Flood and Landslide 10/2026")).toBe("Myanmar - Flood and Landslide");
    expect(dropTrailingDate("Nepal: Rasuwa Flash Flood, 2026")).toBe("Nepal: Rasuwa Flash Flood");
    expect(dropTrailingDate("Tunisia Wildfires 2026")).toBe("Tunisia Wildfires");
    expect(dropTrailingDate("Algeria: Wildfires – July 2026")).toBe("Algeria: Wildfires – July 2026");
    expect(dropTrailingDate("Floods in Moldova May-June 2026")).toBe("Floods in Moldova May-June 2026");
    expect(dropTrailingDate("2026")).toBe("2026");
  });
});

describe("tidyTitle", () => {
  it("tidies real emergency names", () => {
    expect(tidyTitle("Nepal: Rasuwa Flash Flood, 2026", "Nepal")).toBe("Nepal: Rasuwa Flash Flood");
    expect(tidyTitle("PAN: Flood - 08-2026 - Bocas del Toro Floods ", "Panama")).toBe("Panama: Bocas del Toro Floods");
    expect(tidyTitle("SLE: Pluvial/Flash Flood - 08-2026 - SLE: Flash Flood - 08-2026 - Freetown ", "Sierra Leone")).toBe("Sierra Leone: Freetown flash flood");
    expect(tidyTitle("ZWE: Other - 10-2026 - Masvingo Hailstorm ", "Zimbabwe")).toBe("Zimbabwe: Masvingo Hailstorm");
    expect(tidyTitle("TJK: Flood - 07-2026 - TJK: Flood and Mudflow Ayni district ", "Tajikistan")).toBe("Tajikistan: Flood and Mudflow Ayni district");
    expect(tidyTitle("DZA: Fire - 07-2026 - Algeria: Wildfires – July 2026 ", "Algeria")).toBe("Algeria: Wildfires – July 2026");
    expect(tidyTitle("MMR: Flood - 10-2026 - Myanmar - Flood and Landslide 10/2026", "Myanmar")).toBe("Myanmar - Flood and Landslide");
    expect(tidyTitle("Liberia : Floods - 08-2026", "Liberia")).toBe("Liberia: Floods");
    expect(tidyTitle("Panama Earthquake - 2026", "Panama")).toBe("Panama Earthquake");
    expect(tidyTitle("Venezuela Earthquake", "Venezuela")).toBe("Venezuela Earthquake");
  });

  it("drops trailing appeal codes", () => {
    expect(tidyTitle("Bangladesh - Population Movement (MDRBD018)")).toBe("Bangladesh - Population Movement");
    expect(tidyTitle("Tajikistan - Cold Wave (EAP2022TJ02)")).toBe("Tajikistan - Cold Wave");
    expect(tidyTitle("Mozambique (Cyclone Freddy)")).toBe("Mozambique (Cyclone Freddy)");
  });

  it("leaves a generated name without a country as it is, and never returns empty", () => {
    expect(tidyTitle("GEO: Flood - 06-2026 - Heavy Rain and Floods in Samegrelo")).toBe("Heavy Rain and Floods in Samegrelo");
    expect(tidyTitle(" 2026 ")).toBe("2026");
  });
});

describe("hazardName", () => {
  it("finds storm names", () => {
    expect(hazardName(["Solomon Islands Tropical Storm Maila"], "cyclone")).toBe("MAILA");
    expect(hazardName(["Jamaica - Hurricane Melissa"], "cyclone")).toBe("MELISSA");
    expect(hazardName(["Philippines: Southwest Monsoon enhanced by Tropical Cyclones Maymay and Dolphin, 2026"], "cyclone")).toBe("MAYMAY");
    expect(hazardName(["Madagascar – Tropical Cyclone", "Bangladesh - Cyclone and floods", "Cyclone Chido"], "cyclone")).toBe("CHIDO");
  });

  it("finds a storm name written in quotes", () => {
    expect(hazardName(["Mozambique - Tropical Cyclone 'Jude'"], "cyclone")).toBe("JUDE");
    expect(hazardName(["Cuba - Hurricane “Melissa”"], "cyclone")).toBe("MELISSA");
  });

  it("finds volcano names and nothing for other types", () => {
    expect(hazardName(["Indonesia: Mount Lewotobi eruption"], "volcano")).toBe("LEWOTOBI");
    expect(hazardName(["Kanlaon Volcano eruption"], "volcano")).toBe("KANLAON");
    expect(hazardName(["Vanuatu - Volcanic Eruption Imminent"], "volcano")).toBeUndefined();
    expect(hazardName(["Hurricane Melissa"], "flood")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("eventFigures", () => {
  it("turns real key figures into figures sourced to the GO page", () => {
    const figs = eventFigures(parseEvent(EVENTS["8073"])!, emergencyPage(8073));
    expect(figs).toHaveLength(6);
    expect(figs[0]).toEqual({ label: "Confirmed Dead", value: "1,451", sourceName: "NDRRMA", sourceUrl: "https://go.ifrc.org/emergencies/8073" });
    expect(figs.some((f) => f.label === "People affected")).toBe(false); // "Affected" is already there
  });

  it("adds people affected when no figure covers it, and dedupes labels", () => {
    const figs = eventFigures({ keyFigures: [{ number: "3", deck: "Deaths", source: "" }, { number: "4", deck: "deaths", source: "" }], affected: 1200 }, "u");
    expect(figs).toEqual([
      { label: "Deaths", value: "3", sourceName: "IFRC", sourceUrl: "u" },
      { label: "People affected", value: "1,200", sourceName: "IFRC", sourceUrl: "u" },
    ]);
  });
});

describe("extrasFromEvent", () => {
  it("collects a real record's countries, summary, figures and GLIDE", () => {
    const x = extrasFromEvent(parseEvent(EVENTS["8055"])!, resolve, shapes);
    expect(x).toMatchObject({ public: true, name: "Colombia - Earthquake 2026", countries: ["CO"], places: [], started: "2026-08-10T00:00:00.000Z", glide: "EQ-2026-000146-COL" });
    expect(x.summary).toMatch(/^According to information from the Colombian Geological Service/);
    expect(x.figures.length).toBeGreaterThan(0);
  });
});

describe("extrasFromPrevious and findPrevious", () => {
  const prev: SourceEvent = {
    source: "ifrc",
    sourceId: "8073",
    type: "flood",
    title: "Nepal: Rasuwa Flash Flood",
    severity: 2,
    countries: ["NP"],
    lat: 27.6787,
    lng: 85.4706,
    precision: "area",
    started: "2026-08-26T00:00:00.000Z",
    updated: "2026-10-13T12:19:47.651Z",
    areas: [],
    places: [{ name: "Bagmati", country: "NP", lat: 27.6787, lng: 85.4706, kind: "district", source: "ifrc" }],
    summary: "A flood.",
    figures: [
      { label: "Missing", value: "5,705", sourceName: "NDRRMA", sourceUrl: "u" },
      { label: TARGET_LABEL, value: "28,000", sourceName: "IFRC", sourceUrl: "u" },
    ],
    links: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/8073" }],
    glide: "FF-2026-000162-NPL",
    revision: "2026-10-13T12:19:47.651852Z",
  };

  it("rebuilds the extras, without the appeal-derived figure", () => {
    expect(extrasFromPrevious(prev)).toEqual({
      public: true,
      name: "Nepal: Rasuwa Flash Flood",
      countries: ["NP"],
      places: prev.places,
      started: "2026-08-26T00:00:00.000Z",
      lastActive: prev.updated,
      summary: "A flood.",
      figures: [prev.figures![0]],
      glide: "FF-2026-000162-NPL",
    });
    expect(extrasFromPrevious({ ...prev, links: [{ name: "IFRC GO country page", url: countryPage(123) }] }).public).toBe(false);
  });

  it("finds the previous IFRC report by source id only", () => {
    expect(findPrevious([{ ...prev, source: "gdacs" }, prev], "8073")).toBe(prev);
    expect(findPrevious([prev], "8074")).toBeUndefined();
    expect(fallbackExtras(prev).revision).toBeUndefined();
    expect(fallbackExtras(prev).extras.places).toEqual(prev.places);
    expect(fallbackExtras(undefined)).toEqual({ extras: emptyExtras() });
  });
});

describe("revisionOf", () => {
  it("is the emergency's update time, or the lone appeal's name and country", () => {
    expect(revisionOf(makeOp([appeal("MDRNP022")]))).toBe("2026-10-13T12:19:47.651852Z");
    expect(revisionOf(makeOp([appeal("MDRID029")]))).toBe("appeal:indonesia earthquake:");
    expect(revisionOf(makeOp([makeAppeal({ eventInfo: null })]))).toBeUndefined();
  });
});

describe("severityOf and severityText", () => {
  it("maps IFRC colours, raising Emergency Appeals to at least 2", () => {
    const dref = [{ kind: "DREF" }];
    const ea = [{ kind: "Emergency Appeal" }];
    expect(severityOf("Red", dref)).toBe(3);
    expect(severityOf("Orange", dref)).toBe(2);
    expect(severityOf("Yellow", dref)).toBe(1);
    expect(severityOf(null, dref)).toBe(1);
    expect(severityOf("Yellow", ea)).toBe(2);
    expect(severityOf("Red", ea)).toBe(3);
  });

  it("describes the alert and operations", () => {
    expect(severityText("Orange", [{ kind: "Emergency Appeal" }])).toBe("IFRC Orange alert, Emergency Appeal");
    expect(severityText("RED", [{ kind: "DREF" }, { kind: "Emergency Appeal" }])).toBe("IFRC Red alert, DREF and Emergency Appeal");
    expect(severityText(null, [{ kind: "DREF" }])).toBe("IFRC DREF operation");
  });
});

describe("targetFigure", () => {
  it("takes the largest target, or none", () => {
    expect(targetFigure([{ people: 13_500 }, { people: 28_000 }, { people: null }], "u")).toEqual({ label: TARGET_LABEL, value: "28,000", sourceName: "IFRC", sourceUrl: "u" });
    expect(targetFigure([{ people: null }], "u")).toBeUndefined();
  });
});

describe("operationPage and toAppealRef", () => {
  it("links the public emergency, else the country page, else GO's emergency list", () => {
    const op = makeOp([appeal("MDRNP022")]);
    expect(operationPage(op, true)).toEqual({ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/8073" });
    expect(operationPage(op, false)).toEqual({ name: "IFRC GO country page", url: "https://go.ifrc.org/countries/123" });
    expect(operationPage(makeOp([appeal("MDRID029")]), false)).toEqual({ name: "IFRC GO emergencies", url: "https://go.ifrc.org/emergencies" });
  });

  it("makes appeal refs with whole francs", () => {
    const ref = toAppealRef(appeal("MDRNP022"), emergencyPage(8073), true);
    expect(ref).toMatchObject({ code: "MDRNP022", name: "Rasuwa Flash Flood", kind: "Emergency Appeal", requested: 18_000_000, url: "https://go.ifrc.org/emergencies/8073", end: "2028-08-31T00:00:00.000Z" });
    expect(Number.isInteger(ref.funded)).toBe(true);
    expect(toAppealRef(makeAppeal({ event: null }), "x", false).url).toBe("https://go.ifrc.org/countries/77");
  });
});

describe("operationTitle", () => {
  it("prefers the emergency's name, then the lead appeal's when that is long or missing", () => {
    expect(operationTitle(makeOp([makeAppeal()]), emptyExtras(), "Thailand")).toBe("Thailand: Chiang Mai Floods");
    const long = makeAppeal({ name: "Indonesia - Drought", eventInfo: { name: `IDN: Drought - 06-2026 - Anticipatory Action: ${"Severe Drought Risk ".repeat(4)}`, severity: null, updatedAt: null } });
    expect(operationTitle(makeOp([long]), emptyExtras(), "Indonesia")).toBe("Indonesia - Drought");
    expect(operationTitle(makeOp([makeAppeal({ eventInfo: null, name: "Testland - Floods 2026" })]), emptyExtras())).toBe("Testland - Floods");
    expect(operationTitle(makeOp([makeAppeal()]), { ...emptyExtras(), name: "Thailand: Northern floods" }, "Thailand")).toBe("Thailand: Northern floods");
  });
});

describe("toSourceEvent", () => {
  it("builds a report from a real Emergency Appeal and its record", () => {
    const op = makeOp([appeal("MDRNP022")]);
    const extras = { ...extrasFromEvent(parseEvent(EVENTS["8073"])!, resolve, shapes), places: districtPlaces(parseDistricts(DISTRICTS_BY_ID)!.filter((d) => d.id === 3527), "NP", resolve, shapes) };
    const ev = toSourceEvent(op, { extras, revision: "r1" }, resolve, shapes)!;
    expect(ev).toMatchObject({
      source: "ifrc",
      sourceId: "8073",
      type: "flood",
      title: "Nepal: Rasuwa Flash Flood",
      severity: 2,
      severityText: "IFRC Orange alert, Emergency Appeal",
      countries: ["NP"],
      lat: 27.6787,
      lng: 85.4706,
      precision: "area",
      started: "2026-08-26T00:00:00.000Z",
      // The field report and appeal date, not GO's record edit time (13 Oct).
      updated: "2026-08-26T00:00:00.000Z",
      areas: [],
      links: [{ name: "IFRC GO emergency", url: "https://go.ifrc.org/emergencies/8073" }],
      glide: "FF-2026-000162-NPL",
      revision: "r1",
    });
    expect(ev.places).toEqual([{ name: "Bagmati", country: "NP", lat: 27.6787, lng: 85.4706, kind: "district", source: "ifrc" }]);
    expect(ev.figures?.at(-1)).toEqual({ label: TARGET_LABEL, value: "28,000", sourceName: "IFRC", sourceUrl: "https://go.ifrc.org/emergencies/8073" });
    expect(ev.appeals).toHaveLength(1);
    expect(ev.summary).toMatch(/^A major flash flood/);
    expect(ev.name).toBeUndefined();
  });

  it("places an appeal without a record at its country's centre", () => {
    const ev = toSourceEvent(makeOp([appeal("MDRID029")], { type: "earthquake" }), { extras: emptyExtras() }, resolve, shapes)!;
    expect(ev).toMatchObject({ sourceId: "appeal-MDRID029", title: "Indonesia - Earthquake", countries: ["ID"], precision: "country", severity: 1, places: [] });
    expect(ev.revision).toBeUndefined();
    expect(ev.links).toEqual([{ name: "IFRC GO emergencies", url: "https://go.ifrc.org/emergencies" }]);
    expect({ lat: ev.lat, lng: ev.lng }).toEqual(countryCentroid("ID", shapes));
  });

  it("names cyclones for matching and skips what cannot be placed", () => {
    const storm = makeAppeal({ name: "Testland - Hurricane Melissa", dtype: "Cyclone", event: null, eventInfo: null });
    expect(toSourceEvent(makeOp([storm], { type: "cyclone" }), { extras: emptyExtras() }, resolve, shapes)?.name).toBe("MELISSA");
    const nowhere = makeAppeal({ code: "MDRS10005", name: "Region - Floods", country: null });
    expect(toSourceEvent(makeOp([nowhere]), { extras: emptyExtras() }, resolve, shapes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loading extras and the whole run
// ---------------------------------------------------------------------------

describe("loadExtras", () => {
  const ops = selectOperations(parseAppealList(APPEALS)!.appeals, NOW);
  const op = (key: string) => ops.find((o) => o.key === key)!;

  it("reads records, looks up their districts in one batch, and finds districts in titles when a record is not public", async () => {
    const { deps, calls } = fakeDeps();
    const out = await loadExtras([op("8073"), op("8055"), op("8115"), op("8108")], { deps, resolve, shapes, previous: [] });
    expect(out.get("8073")?.extras.places.map((p) => p.name)).toEqual(["Bagmati"]);
    expect(out.get("8055")?.extras.places.map((p) => p.name)).toEqual(["Caldas", "Choco", "Risaralda", "Valle del Cauca"]);
    expect(out.get("8115")?.extras).toMatchObject({ public: false, places: [{ name: "Likouala", country: "CG", kind: "district" }] });
    expect(out.get("8108")?.extras.places.map((p) => p.name)).toEqual(["Masvingo"]);
    expect(out.get("8073")?.revision).toBe("2026-10-13T12:19:47.651852Z");
    expect(out.get("8115")?.revision).toBe(op("8115").appeals[0].eventInfo?.updatedAt);
    expect(calls.filter((u) => u.includes("id__in="))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("country__iso3="))).toEqual([districtsOfCountryUrl("COG"), districtsOfCountryUrl("ZWE")]);
  });

  it("reuses the previous run's extras while GO's update time is unchanged", async () => {
    const first = fakeDeps();
    const extras = await loadExtras([op("8073")], { deps: first.deps, resolve, shapes, previous: [] });
    const prev = toSourceEvent(op("8073"), extras.get("8073")!, resolve, shapes)!;
    const second = fakeDeps();
    const again = await loadExtras([op("8073")], { deps: second.deps, resolve, shapes, previous: [prev] });
    expect(second.calls).toEqual([]);
    expect(again.get("8073")?.extras.places).toEqual(prev.places);
    const changed = fakeDeps();
    await loadExtras([op("8073")], { deps: changed.deps, resolve, shapes, previous: [{ ...prev, revision: "older" }] });
    expect(changed.calls).toContain(eventUrl(8073));
  });

  it("keeps the previous run's extras, unrevised, when a record cannot be read", async () => {
    const prev = toSourceEvent(op("8073"), { extras: { ...emptyExtras(true), places: [{ name: "Bagmati", country: "NP", lat: 27.7, lng: 85.5, kind: "district", source: "ifrc" }] } }, resolve, shapes)!;
    const { deps } = fakeDeps(goServer({ [eventUrl(8073)]: { status: 500 } }));
    const out = await loadExtras([op("8073")], { deps, resolve, shapes, previous: [{ ...prev, revision: "older" }] });
    expect(out.get("8073")).toEqual({ extras: extrasFromPrevious(prev) });
  });

  it("keeps previous places, unrevised, when the district lookup fails", async () => {
    const prev = toSourceEvent(op("8055"), { extras: { ...emptyExtras(true), places: [{ name: "Old", country: "CO", lat: 5, lng: -75, kind: "district", source: "ifrc" }] } }, resolve, shapes)!;
    const { deps } = fakeDeps((url) => (url.includes("id__in=") ? { status: 500 } : goServer()(url)));
    const out = await loadExtras([op("8055")], { deps, resolve, shapes, previous: [{ ...prev, revision: "older" }] });
    expect(out.get("8055")?.revision).toBeUndefined();
    expect(out.get("8055")?.extras.places.map((p) => p.name)).toEqual(["Old"]);
    expect(out.get("8055")?.extras.summary).toMatch(/Colombian Geological Service/);
  });

  it("caps record reads per run, sparing Emergency Appeals", async () => {
    const many = Array.from({ length: MAX_DETAIL_FETCHES + 3 }, (_, i) =>
      makeOp([makeAppeal({ code: `MDRTH${String(i).padStart(3, "0")}`, event: 10_000 + i, kind: i === MAX_DETAIL_FETCHES + 2 ? "Emergency Appeal" : "DREF" })]),
    );
    const { deps, calls } = fakeDeps(() => ({ status: 404 }));
    const out = await loadExtras(many, { deps, resolve, shapes, previous: [] });
    expect(calls.filter((u) => u.includes("/event/"))).toHaveLength(MAX_DETAIL_FETCHES);
    expect(calls).toContain(eventUrl(10_000 + MAX_DETAIL_FETCHES + 2));
    expect(out.size).toBe(many.length);
    expect([...out.values()].filter((x) => x.revision === undefined).length).toBeGreaterThanOrEqual(3);
  });

  it("caps country district lookups per run", async () => {
    const codes = shapes.filter((s) => s.iso3 && /^[A-Z]{2}$/.test(s.code)).slice(0, MAX_COUNTRY_LOOKUPS + 2);
    const lone = codes.map((s, i) => makeOp([makeAppeal({ code: `MDR${s.code}0${i}`, event: null, eventInfo: null, country: { iso: s.code, iso3: s.iso3!, id: i, name: s.name } })]));
    const { deps, calls } = fakeDeps(() => ({ results: [] }));
    const out = await loadExtras(lone, { deps, resolve, shapes, previous: [] });
    expect(calls).toHaveLength(MAX_COUNTRY_LOOKUPS);
    expect([...out.values()].filter((x) => x.revision === undefined)).toHaveLength(2);
  });
});

describe("districtCentre", () => {
  it("is the matched districts' centre, else the country's, else nothing", () => {
    const a = district({ id: 1, lat: 10, lng: 20 });
    const b = district({ id: 2, lat: 10, lng: 22 });
    expect(districtCentre([a], [a, b])).toEqual({ lat: 10, lng: 20, precision: "area" });
    expect(districtCentre([], [a, b])).toMatchObject({ lng: 21, precision: "country" });
    expect(districtCentre([], [])).toBeUndefined();
  });
});

describe("countries the globe does not draw, and GO's own country codes", () => {
  const CPV = { iso: "CV", iso3: "CPV", id: 60, name: "Cabo Verde" };
  const praia = (COUNTRY_DISTRICTS.CPV as { results: { id: number; name: string; centroid: { coordinates: [number, number] } }[] }).results.find((r) => r.name === "Praia")!;
  const capeVerde = makeAppeal({ code: "MDRCV007", name: "Cabo Verde - Floods in Praia", country: CPV, event: null, eventInfo: null });

  it("places an operation in a small island state at its districts rather than dropping it", async () => {
    const { deps, calls } = fakeDeps();
    const op = makeOp([capeVerde]);
    const out = await loadExtras([op], { deps, resolve, shapes, previous: [] });
    expect(calls).toEqual([districtsOfCountryUrl("CPV")]);
    expect(out.get(op.key)?.extras.centre).toEqual({ lat: round(praia.centroid.coordinates[1]), lng: round(praia.centroid.coordinates[0]), precision: "area" });
    const ev = toSourceEvent(op, out.get(op.key)!, resolve, shapes)!;
    expect(ev).toMatchObject({ sourceId: "appeal-MDRCV007", countries: [], precision: "area", places: [], title: "Cabo Verde - Floods in Praia" });
    expect(ev.lat).toBeCloseTo(praia.centroid.coordinates[1], 3);
    expect(ev.appeals?.[0].url).toBe(countryPage(60));
  });

  it("falls back to the centre of all its districts when the title names none", async () => {
    const op = makeOp([makeAppeal({ ...capeVerde, name: "Cabo Verde - Floods" })]);
    const out = await loadExtras([op], { deps: fakeDeps().deps, resolve, shapes, previous: [] });
    expect(out.get(op.key)?.extras.centre?.precision).toBe("country");
  });

  it("uses the districts of a public emergency there", async () => {
    const op = makeOp([makeAppeal({ ...capeVerde, event: 9100, eventInfo: { name: "CPV: Flood - 10-2026 - Praia floods", severity: "Yellow", updatedAt: "2026-10-11T00:00:00Z" } })]);
    const record = { id: 9100, name: "CPV: Flood - 10-2026 - Praia floods", countries: [CPV], districts: [{ id: praia.id, name: "Praia" }], updated_at: "2026-10-11T00:00:00Z", summary: "" };
    const { deps } = fakeDeps(goServer({ [eventUrl(9100)]: record, [districtsByIdUrl([praia.id])]: { results: [praia] } }));
    const out = await loadExtras([op], { deps, resolve, shapes, previous: [] });
    expect(out.get(op.key)).toMatchObject({ revision: "2026-10-11T00:00:00Z", extras: { public: true, places: [], centre: { precision: "area" } } });
  });

  it("keeps the centre on reuse and when a later lookup fails", async () => {
    const op = makeOp([capeVerde]);
    const first = await loadExtras([op], { deps: fakeDeps().deps, resolve, shapes, previous: [] });
    const prev = toSourceEvent(op, first.get(op.key)!, resolve, shapes)!;
    expect(extrasFromPrevious(prev).centre).toEqual({ lat: prev.lat, lng: prev.lng, precision: "area" });
    const again = fakeDeps();
    const reused = await loadExtras([op], { deps: again.deps, resolve, shapes, previous: [prev] });
    expect(again.calls).toEqual([]);
    expect(toSourceEvent(op, reused.get(op.key)!, resolve, shapes)).toEqual(prev);
    const failing = fakeDeps(() => ({ status: 503 }));
    const kept = await loadExtras([op], { deps: failing.deps, resolve, shapes, previous: [{ ...prev, revision: "older" }] });
    expect(kept.get(op.key)?.revision).toBeUndefined();
    expect(kept.get(op.key)?.extras.centre).toEqual({ lat: prev.lat, lng: prev.lng, precision: "area" });
  });

  it("looks districts up by GO's own ISO3 (Kosovo is XKX in GO, KOS on the globe)", async () => {
    const kosovo = makeAppeal({ code: "MDRXK001", name: "Kosovo - Floods in Pejë", country: { iso: "XK", iso3: "XKX", id: 335, name: "Kosovo" }, event: null, eventInfo: null });
    const { deps, calls } = fakeDeps();
    const out = await loadExtras([makeOp([kosovo])], { deps, resolve, shapes, previous: [] });
    expect(calls).toEqual([districtsOfCountryUrl("XKX")]);
    expect(out.get("appeal-MDRXK001")?.extras.places).toMatchObject([{ name: "Pejë / Pec", country: "XK", kind: "district" }]);
  });

  it("keeps a small island state's operation in the whole run", async () => {
    const row = {
      code: "MDRCV007", name: "Cabo Verde - Floods in Praia", atype_display: "DREF", dtype: { id: 12, name: "Flood" },
      amount_requested: 150_000, amount_funded: 0, num_beneficiaries: 2_000, start_date: "2026-10-10T00:00:00Z", end_date: "2027-01-31T00:00:00Z",
      event: null, event_details: null, country: CPV,
    };
    const list = { count: APPEALS.results.length + 1, next: null, previous: null, results: [...APPEALS.results, row] };
    const events = (await fetchIfrc(fakeDeps(goServer({ [APPEALS_URL]: list })).deps, NOW, resolve, shapes))!;
    expect(events.find((e) => e.sourceId === "appeal-MDRCV007")).toMatchObject({ type: "flood", countries: [], precision: "area" });
  });
});

/** Rounds as the module does (4 decimals). */
function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

describe("fetchIfrc", () => {
  it("turns the real fixtures into placed disaster reports, most severe first", async () => {
    const { deps, calls, sleep } = fakeDeps();
    const events = (await fetchIfrc(deps, NOW, resolve, shapes))!;
    expect(events.map((e) => e.sourceId).sort()).toEqual(
      ["7990", "7993", "8014", "8027", "8034", "8038", "8055", "8057", "8073", "8101", "8108", "8110", "8115", "appeal-MDRID029"].sort(),
    );
    expect(events[0]).toMatchObject({ sourceId: "7990", severity: 3, title: "Venezuela Earthquake", type: "earthquake", precision: "area" });
    for (let i = 1; i < events.length; i++) expect(events[i - 1].severity).toBeGreaterThanOrEqual(events[i].severity);
    const byId = (id: string) => events.find((e) => e.sourceId === id)!;
    expect(byId("8115")).toMatchObject({ type: "flood", countries: ["CG"], precision: "area", links: [{ name: "IFRC GO country page" }] });
    expect(byId("8115").appeals?.[0].url).toBe("https://go.ifrc.org/countries/184");
    expect(byId("8027")).toMatchObject({ type: "wildfire", precision: "area", countries: ["DZ"] });
    expect(byId("8101")).toMatchObject({ type: "storm", precision: "country", title: "Guinea-Bissau - Windstorm" });
    expect(byId("7993")).toMatchObject({ countries: ["GE"], precision: "area" });
    expect(byId("8034")).toMatchObject({ type: "cyclone", countries: ["DJ"], precision: "country" });
    for (const e of events) {
      expect(e.source).toBe("ifrc");
      expect(e.appeals?.length).toBeGreaterThan(0);
      expect(Number.isFinite(e.lat) && Number.isFinite(e.lng)).toBe(true);
      expect(JSON.stringify(e)).not.toMatch(/@|phone|email/i);
    }
    expect(calls[0]).toBe(APPEALS_URL);
    expect(sleep).toHaveBeenCalledWith(DETAIL_GAP_MS);
  });

  it("asks only for the appeal list when nothing changed since the previous run", async () => {
    const first = (await fetchIfrc(fakeDeps().deps, NOW, resolve, shapes))!;
    const { deps, calls } = fakeDeps();
    const second = await fetchIfrc(deps, NOW, resolve, shapes, first);
    const unchanged = first.filter((e) => e.revision !== undefined).map((e) => e.sourceId);
    expect(unchanged.length).toBeGreaterThan(10);
    expect(calls.filter((u) => unchanged.some((id) => u === eventUrl(Number(id))))).toEqual([]);
    expect(second?.filter((e) => unchanged.includes(e.sourceId))).toEqual(first.filter((e) => unchanged.includes(e.sourceId)));
  });

  it("returns null when the appeal list cannot be read", async () => {
    const { deps, log } = fakeDeps(goServer({ [APPEALS_URL]: new Error("timeout") }));
    expect(await fetchIfrc(deps, NOW, resolve, shapes)).toBeNull();
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/previous data kept/);
  });
});

describe("latestReport", () => {
  it("takes the newest field report date, falling back to created_at, and ignores junk", () => {
    expect(
      latestReport([
        { report_date: "2026-08-26T05:39:07.383814Z", created_at: "2026-08-26T05:39:07Z" },
        { report_date: null, created_at: "2026-09-02T10:00:00Z" },
        null,
        { report_date: "not a date" },
      ]),
    ).toBe("2026-09-02T10:00:00.000Z");
    expect(latestReport([])).toBeNull();
  });
});
