import { describe, expect, it } from "vitest";
import type { CountryConfig } from "./countries";
import type { Article, FetchDeps } from "./googlenews";
import { MAX_AGE_DAYS, buildList, combine, fetchLocalSources, fetchWorldSources, isRecent, sourceName, type Sources } from "./sources";

const NOW = "2026-10-21T12:00:00.000Z";
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000);

/** A Google News feed of [link, title, outlet, hours ago] items. */
const google = (items: [string, string, string, number][]) =>
  `<rss><channel><title>Google News</title>${items
    .map(([link, title, outlet, h]) => `<item><title>${title} - ${outlet}</title><link>${link}</link><pubDate>${ago(h).toUTCString()}</pubDate><source url="https://${outlet}.example">${outlet}</source></item>`)
    .join("")}</channel></rss>`;
/** A Bing News feed of [publisher link, title, outlet, hours ago] items. */
const bing = (items: [string, string, string, number][]) =>
  `<rss xmlns:News="https://www.bing.com/news"><channel><title>Bing</title>${items
    .map(([link, title, outlet, h]) => `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(link)}</link><pubDate>${ago(h).toUTCString()}</pubDate><News:Source>${outlet}</News:Source></item>`)
    .join("")}</channel></rss>`;

const TH: CountryConfig = {
  code: "TH",
  name: "Thailand",
  enabled: true,
  kind: "local",
  edition: { hl: "th", gl: "TH", ceid: "TH:th" },
  local: { lang: "th", name: "ประเทศไทย" },
};
const TD: CountryConfig = { code: "TD", name: "Chad", enabled: true, kind: "world", query: '"Chad"', local: { lang: "fr", name: "Tchad" } };

const TOP = google([
  ["https://g/a", "Flood warning for the south", "Thai PBS", 1],
  ["https://g/b", "Cabinet approves budget", "Matichon", 3],
]);
const NATION = google([
  ["https://g/b", "Cabinet approves budget", "Matichon", 3],
  ["https://g/c", "New rail line opens in the north", "Thairath", 2],
]);
const WORLD = google([["https://g/d", "Talks resume in Oslo", "Thai PBS", 4]]);
const BING = bing([["https://pub/e", "Gold price steady today", "Khaosod", 1]]);
/** A full page of Bing results, after which Bing has a second page. */
const FULL_BING = bing(Array.from({ length: 12 }, (_, i): [string, string, string, number] => [`https://pub/f${i}`, `Story number ${i}`, "Khaosod", 1]));

/** A fake network: answers by URL, records every request and wait in order. */
function network(routes: Record<string, () => Response>) {
  const events: string[] = [];
  const deps: FetchDeps = {
    fetch: (async (input: string | URL) => {
      const url = String(input);
      const key = Object.keys(routes).find((k) => url.includes(k));
      events.push(`fetch ${key ?? url}`);
      return key ? routes[key]() : new Response("", { status: 404 });
    }) as typeof fetch,
    sleep: async (ms) => void events.push(`sleep ${ms}`),
    log: () => {},
  };
  return { deps, events };
}
const ok = (body: string) => () => new Response(body, { status: 200 });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

const LOCAL_ROUTES = {
  "rss?hl=th": ok(TOP),
  "topic/NATION": redirect("https://news.google.com/rss/topics/NATIONID?hl=th&gl=TH&ceid=TH:th"),
  "topics/NATIONID": ok(NATION),
  "topic/WORLD": redirect("https://news.google.com/rss/topics/WORLDID?hl=th&gl=TH&ceid=TH:th"),
  "topics/WORLDID": ok(WORLD),
  "bing.com/news/search": ok(BING),
};

describe("fetchLocalSources", () => {
  it("reads top stories, NATION, WORLD and Bing, top stories first", async () => {
    const { deps } = network(LOCAL_ROUTES);
    const s = await fetchLocalSources(TH, 2000, deps);
    expect(s?.articles.map((a) => a.url)).toEqual(["https://g/a", "https://g/b", "https://g/b", "https://g/c", "https://g/d", "https://pub/e"]);
    expect(s?.top).toEqual(["https://g/a", "https://g/b"]);
    expect(s?.services).toEqual(["Google News", "Bing News"]);
    expect(s?.url).toBe("https://news.google.com/rss?hl=th&gl=TH&ceid=TH%3Ath");
  });
  it("reads only one page of Bing, even when it is full", async () => {
    const { deps, events } = network({ ...LOCAL_ROUTES, "bing.com/news/search": ok(FULL_BING) });
    const s = await fetchLocalSources(TH, 2000, deps);
    expect(s?.articles.filter((a) => a.url.startsWith("https://pub/"))).toHaveLength(12);
    expect(events.filter((e) => e.includes("bing"))).toEqual(["fetch bing.com/news/search"]);
  });
  it("paces the Google requests, with Bing alongside", async () => {
    const { deps, events } = network(LOCAL_ROUTES);
    await fetchLocalSources(TH, 2000, deps);
    expect(events.filter((e) => !e.includes("bing"))).toEqual([
      "fetch rss?hl=th",
      "sleep 2000",
      "fetch topic/NATION",
      "fetch topics/NATIONID",
      "sleep 2000",
      "fetch topic/WORLD",
      "fetch topics/WORLDID",
    ]);
  });
  it("searches Bing in the country's language and market", async () => {
    const urls: string[] = [];
    const { deps } = network(LOCAL_ROUTES);
    const f = deps.fetch;
    deps.fetch = (async (input: string, init?: RequestInit) => {
      urls.push(String(input));
      return f(input, init);
    }) as typeof fetch;
    await fetchLocalSources(TH, 0, deps);
    const q = new URL(urls.find((u) => u.includes("bing"))!);
    expect([q.searchParams.get("q"), q.searchParams.get("cc"), q.searchParams.get("setlang")]).toEqual(["ประเทศไทย", "TH", "th"]);
  });
  it("skips Bing for an edition without a search", async () => {
    const { deps, events } = network(LOCAL_ROUTES);
    const s = await fetchLocalSources({ ...TH, local: undefined }, 0, deps);
    expect(s?.services).toEqual(["Google News"]);
    expect(events.some((e) => e.includes("bing"))).toBe(false);
  });
  it("carries on when some feeds fail, and gives up only when all do", async () => {
    const down = () => new Response("", { status: 503 });
    const partly = network({ ...LOCAL_ROUTES, "rss?hl=th": down, "bing.com/news/search": down });
    const s = await fetchLocalSources(TH, 0, partly.deps);
    expect(s?.top).toEqual([]);
    expect(s?.services).toEqual(["Google News"]);
    expect(s?.url).toContain("topic/NATION");
    const none = network({});
    expect(await fetchLocalSources(TH, 0, none.deps)).toBeNull();
    expect(await fetchLocalSources({ ...TH, edition: undefined }, 0, none.deps)).toBeNull();
  });
  it("keeps the previous list when only Bing answered", async () => {
    const logs: string[] = [];
    const { deps } = network({ "bing.com/news/search": ok(BING) });
    expect(await fetchLocalSources(TH, 0, { ...deps, log: (m) => logs.push(m) })).toBeNull();
    expect(logs.at(-1)).toBe("  TH: no Google News feed answered");
  });
});

describe("fetchWorldSources", () => {
  const routes = {
    "bing.com/news/search": ok(bing([["https://pub/1", "Tchad : réunion de sécurité", "Alwihda", 2]])),
    "rss/search": ok(google([["https://g/1", "Chad opens new border post", "Reuters", 5]])),
  };
  it("reads Bing in the press language, then Google News in English", async () => {
    const { deps } = network(routes);
    const s = await fetchWorldSources(TD, 0, deps);
    expect(s?.articles.map((a) => a.url)).toEqual(["https://pub/1", "https://g/1"]);
    expect(s?.services).toEqual(["Bing News", "Google News"]);
    expect(s?.top).toEqual([]);
    expect(s?.url).toContain("bing.com");
  });
  it("uses whichever answered, or null", async () => {
    const { deps } = network({ "rss/search": routes["rss/search"] });
    expect((await fetchWorldSources(TD, 0, deps))?.services).toEqual(["Google News"]);
    expect(await fetchWorldSources(TD, 0, network({}).deps)).toBeNull();
  });
});

describe("combine", () => {
  const feed = (url: string, articles: Article[] = []) => ({ url, articles });
  it("joins the feeds that answered and names each service once", () => {
    const top = feed("t", [{ title: "A", url: "a", outlet: "O", outletUrl: null, published: NOW }]);
    expect(combine([["Google News", null], ["Google News", top], ["Bing News", feed("b")]], top)).toEqual({
      url: "t",
      articles: top.articles,
      top: ["a"],
      services: ["Google News", "Bing News"],
    });
    expect(combine([["Bing News", null]], null)).toBeNull();
  });
});

describe("buildList", () => {
  const art = (url: string, title: string, outlet: string, h: number, related?: string[]): Article => ({
    url,
    title,
    outlet,
    outletUrl: null,
    published: ago(h).toISOString(),
    ...(related ? { related } : {}),
  });
  it("drops repeats and junk, groups by story, ranks and cuts to the limit", () => {
    const sources: Sources = {
      url: "u",
      top: ["https://g/old"],
      services: ["Google News", "Bing News"],
      articles: [
        art("https://g/old", "Parliament passes the budget after a long debate", "Matichon", 30),
        art("https://g/storm", "Storm Austen brings amber wind warning to the north", "Sky News", 1, ["BBC", "The Guardian"]),
        art("https://g/storm", "Storm Austen brings amber wind warning to the north", "Sky News", 1),
        art("https://pub/storm", "Amber wind warning as Storm Austen hits the north", "ITV News", 2),
        art("https://pub/spam", "Watch Fiji vs Cook Islands live stream free", "Spam", 1),
        art("https://pub/lone", "Hedgehog without prickles becomes a charity ambassador", "BBC", 3),
      ],
    };
    const list = buildList(sources, 2, NOW);
    expect(list.map((a) => a.url)).toEqual(["https://g/storm", "https://pub/lone"]);
    expect(list[0]).toMatchObject({ outlets: 4, trending: true });
    expect(buildList(sources, 10, NOW).map((a) => a.url)).toEqual(["https://g/storm", "https://pub/lone", "https://g/old"]);
  });
  it("counts every outlet that runs the same headline", () => {
    const title = "Alice Schwarzer stellt Magazin „Emma“ ein";
    const sources: Sources = {
      url: "u",
      top: ["https://g/faz"],
      services: ["Google News"],
      articles: [
        art("https://g/faz", title, "FAZ", 6, ["tagesschau.de", "Baden Online", "Spiegel", "n-tv.de"]),
        art("https://g/ts", "Alice Schwarzer stellt Magazin \"Emma\" ein", "tagesschau.de", 3.75, ["Baden Online", "Spiegel", "n-tv.de", "Mindener Tageblatt"]),
      ],
    };
    const list = buildList(sources, 10, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ outlets: 6, url: "https://g/faz" });
  });
  it("shows a headline repeated days apart only once", () => {
    const sources: Sources = {
      url: "u",
      top: [],
      services: ["Bing News"],
      articles: [
        art("https://pub/new", "Government announces new rail plan", "Daily News", 1),
        art("https://pub/old", "Government announces new rail plan!", "Daily News", 60),
      ],
    };
    expect(buildList(sources, 10, NOW).map((a) => a.url)).toEqual(["https://pub/new"]);
  });
  it("leaves out articles older than a week", () => {
    const sources: Sources = {
      url: "u",
      top: [],
      services: ["Bing News"],
      articles: [art("https://pub/now", "Rail strike called off", "Daily News", 2), art("https://pub/2024", "UK", "BBC", 24 * 800)],
    };
    expect(buildList(sources, 10, NOW).map((a) => a.url)).toEqual(["https://pub/now"]);
  });
});

describe("isRecent", () => {
  it("is true up to MAX_AGE_DAYS old", () => {
    expect(isRecent({ published: ago(MAX_AGE_DAYS * 24).toISOString() }, NOW)).toBe(true);
    expect(isRecent({ published: ago(MAX_AGE_DAYS * 24 + 1).toISOString() }, NOW)).toBe(false);
    expect(isRecent({ published: ago(-1).toISOString() }, NOW)).toBe(true);
  });
});

describe("sourceName", () => {
  it("names the services a list came from", () => {
    expect(sourceName(["Google News", "Bing News"])).toBe("Google News and Bing News");
    expect(sourceName(["Bing News", "Google News"])).toBe("Bing News and Google News");
    expect(sourceName(["Google News"])).toBe("Google News");
  });
});
