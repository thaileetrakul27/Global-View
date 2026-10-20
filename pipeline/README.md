# Pipeline

Fetches each country's most popular articles and writes the JSON the website reads into `public/data`. It runs in GitHub Actions every three hours (`.github/workflows/update-news.yml`). The website never calls an API.

## What "most popular" means

The top stories feed of that country's Google News edition. Each run keeps up to 30 articles per country, in Google's order, after removing duplicate and junk headlines. No article text is fetched or stored; the site shows headlines, outlet names, times and links.

## World coverage

Google publishes editions for about 68 countries. Every other country on the globe gets a Google News search for recent articles about it (`"Mongolia" when:3d` in the English edition), capped at 20 and labelled "world coverage" on the site. `pipeline/config/world-queries.json` holds hand-written queries for names that are ambiguous (Georgia, Jordan, Chad, Niger, Guinea) and a short skip list (Antarctica). World coverage is what others write about a country, not what its people read, so it is excluded from shared stories and attention counts.

## What the model does

Four jobs, all optional, all on Claude Haiku 5.5 by default:

1. **Translate.** New headlines go to the model in batches of 40 per country, with the edition named so unnamed places resolve correctly. It returns an English headline and the ISO codes of the countries each headline is about. Results are cached by article link in `cache/headlines.json`, pruned after 48 hours out of every feed, so a headline is never translated twice.
2. **Group shared stories.** One call per run receives every translated headline with its country code and returns groups that describe the same event in at least two countries, each with a short neutral title. Groups are validated: bad indices and single-country groups are dropped.
3. **Spot disasters in the news.** One call per run reads the headlines that name a hazard and returns natural disasters happening now, with the places named. An event needs two outlets and a place that geocodes.
4. **Research disasters.** For the disasters that need it most, a call with web search (at most four searches) finds the affected cities and districts, a short summary, key figures with their sources and candidate donation pages; a second call turns the notes into checked fields. Results are cached per disaster in `cache/research.json` and refreshed every 24 hours for severe disasters, 48 for significant and 96 for minor ones.

The "who reads about whom" counts come from the translation step's country codes and need no extra call. If a model call fails, the previous data is kept and the step is retried next run.

Set `ANTHROPIC_API_KEY` to enable the model. `GLOBAL_VIEW_MODEL` overrides the model for jobs 1 to 3 and `GLOBAL_VIEW_RESEARCH_MODEL` for job 4.

## Budget

All model use is capped at $50 a month (`pipeline/config/budget.json`). `pipeline/lib/spend.ts` prices every call from its real token and search counts and records it in `cache/spend.json`, by purpose and by day. Web research gets a daily allowance: what is left of the month after a $3 safety margin and the projected cost of the other jobs, spread over the days left; each run also researches at most 12 disasters. Once the month's spend reaches $47, the run makes no model calls at all and the feeds still publish. The ledger is saved after every call, and the workflow commits the caches even when an update fails, so a run that is cut off still counts what it spent. Research starts nothing new after 15 minutes, or 40 minutes into the run. The run log ends with this run's spend and the month's total. Raise the spending limit in the Anthropic Console to match.

## Run it

```bash
npm run pipeline:update                          # every enabled country in data/countries.json
npm run pipeline:update -- --countries TH        # one country, enabled or not
npm run pipeline:update -- --countries TH,GB --max 20
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--countries` | all enabled | Comma-separated ISO codes |
| `--max` | `30` | Articles kept per country |
| `--delay` | `2000` | Milliseconds between feed requests |
| `--out` | `public/data` | Where the site's JSON goes |
| `--no-ai` | off | Skip translation and grouping even when a key is set |

Set `NEWS_FEED_ENDPOINT` to point the script at a local stand-in server when testing without the network.

## Failure behaviour

Each feed gets one retry. A country that fails twice keeps its previous file and its previous index entry, so the site shows slightly older stories for it rather than nothing. The run exits non-zero only if every country fails, in which case nothing is written and the workflow commits nothing.

## Output

| File | Holds |
| --- | --- |
| `public/data/index.json` | When the pipeline last ran, and per country the name, article count and refresh time. Colours the globe |
| `public/data/countries/TH.json` | That country's articles: title, link, outlet, outlet site, publish time, English translation and the countries it is about |
| `public/data/shared.json` | Stories read in two or more countries, with the articles behind each |
| `public/data/attention.json` | Per country, how many of its top stories are about each other country |
| `public/data/about/TH.json` | The foreign top stories about Thailand, with the country each was read in |
| `public/data/history/` | One small snapshot per day plus an index, for the time machine |
| `public/data/disasters.json` | Natural disasters ongoing now: type, severity, the areas and places affected, a summary, figures, sources, IFRC appeals and donation pages |
| `cache/headlines.json` | Translation cache, committed so runs on GitHub Actions share it |
| `cache/disaster-sources.json` | Each disaster feed's last good reports, kept when a feed fails |
| `cache/research.json`, `cache/research-attempts.json` | Web research per disaster, and recent failed attempts |
| `cache/geocode.json` | Place names already located with OpenStreetMap Nominatim |
| `cache/donation-registry.json` | Red Cross and Red Crescent societies, donation platform answers, UN Crisis Relief pages and live-check verdicts |
| `cache/spend.json` | The model spend ledger |

## Countries without an edition

Google News has editions for 68 countries. The rest get "world coverage": a Bing News RSS search (`bing.com/news/search?format=rss&cc=XX&setlang=..`) for the country's own name in its press language, from `pipeline/config/languages.json`, which returns what its local outlets publish, two pages of about twelve items; then a Google News search in English for international coverage. The two lists are joined, deduplicated and capped at 20. Either source may fail; only both failing keeps the previous data. Bing's redirect links are unwrapped to the publisher's own URL. Countries not in the language table are searched in English by name.

The junk filter allows combining marks (Thai and Bengali vowels and tones, Arabic diacritics); an earlier version counted them as symbols and dropped nearly every Thai headline.

## Shared stories across runs

Grouping is redone every run, so each new story is matched against the previous file by article overlap. When at least half of the smaller story's articles match, the old id, title and first-seen time are kept; otherwise the story starts now. This keeps `?story=` links and titles stable while the news moves on.

## Daily archive

Every run writes `public/data/history/<YYYY-MM-DD>.json`: the top five articles of each local-edition country and the ten most-shared stories, as last seen that UTC day. `history/index.json` lists the days. The site's day control steps through them. `npx tsx pipeline/derive.ts` recomputes the attention counts, the "about" files, today's snapshot and the disaster map from the data and caches already on disk, without the model; add `--fetch` to refresh the disaster feeds live as well.

## The disaster map

`pipeline/lib/disasters/` builds `public/data/disasters.json` each run:

1. **Feeds.** GDACS (UN and European Commission) gives earthquakes, tropical cyclones, floods, volcanoes, droughts and wildfires with their real footprints: wind zones of 60, 90 and 120 km/h and the storm track, earthquake shaking intensity, flood extents and burned or dry areas. USGS gives earthquakes of magnitude 5.5 and more (or significant, or with a PAGER alert) with ShakeMap contours for the large ones. NASA EONET gives storm tracks, US wildfires (prescribed burns and fires under 5,000 acres left out) and volcanoes. IFRC GO gives the Red Cross and Red Crescent operations for natural disasters, with their districts, summaries and appeals. Each feed's reports are kept in `cache/disaster-sources.json`; when a feed fails, its previous reports are used.
2. **News.** Disasters spotted in the site's own headlines (model job 3), placed by geocoding the places they name. When the geocoder has to stop (an outage or its limit), an event keeps the places it had last run.
3. **Merge.** Reports of the same disaster are joined by GLIDE number, storm or volcano name, or distance, country and time rules per kind of hazard; earthquake aftershocks fold into their main shock. Ids stay stable across runs. A disaster leaves the map when no feed has seen it active for a while (3 days for a cyclone, 21 for a flood, 90 for a drought; longer for strong quakes), unless an IFRC appeal for it is still open.
4. **Research** (model job 4), within the budget. Researched places are geocoded with OpenStreetMap Nominatim (one request a second, at most 80 new names a run, cached forever in `cache/geocode.json`), kept only in the disaster's countries and near it, and drawn as areas when the disaster has no footprint of its own.
5. **Donation pages.** By fixed rules only: the country's Red Cross or Red Crescent society on IFRC's donation platform when it is really there (the landing page must name the society), UN Crisis Relief's page for that country's crisis, the society's own website when it passes a live check, the IFRC appeal, and UN Crisis Relief's and IFRC's general funds so every disaster has at least two. Pages suggested by research are shown only when they are on an allowlisted official domain (the country's own society, the UN family, IFRC and ICRC, or the country's government domains in `pipeline/config/donation-domains.json`; a society site that is one folder of a bigger host, like the Cuban Red Cross on Cuba's health network, allows only that folder) and pass a live check: every redirect stays on the allowlist, the page answers 200 with HTML and it contains a donation word in its language. A society homepage that blocks scripts with 401 or 403 without leaving its own domain is still linked, since a hijacked domain would redirect away or fail the word check.

A run never replaces the map with an empty one. The file is about 700 KB for 200 disasters; each disaster's areas are simplified to stay under about 120 KB.

## Tests

```bash
npm test
```

Every pipeline function has a test next to it (`*.test.ts`). Network calls are mocked. The tests also check that every country in `data/countries.json` exists in the globe's shapes.
