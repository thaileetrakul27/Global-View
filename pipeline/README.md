# Pipeline

Fetches each country's most popular articles and writes the JSON the website reads into `public/data`. It runs in GitHub Actions every three hours (`.github/workflows/update-news.yml`). The website never calls an API.

## What "most popular" means

The top stories feed of that country's Google News edition. Each run keeps up to 30 articles per country, in Google's order, after removing duplicate and junk headlines. No article text is fetched or stored; the site shows headlines, outlet names, times and links.

## World coverage

Google publishes editions for about 68 countries. Every other country on the globe gets a Google News search for recent articles about it (`"Mongolia" when:3d` in the English edition), capped at 20 and labelled "world coverage" on the site. `pipeline/config/world-queries.json` holds hand-written queries for names that are ambiguous (Georgia, Jordan, Chad, Niger, Guinea) and a short skip list (Antarctica). World coverage is what others write about a country, not what its people read, so it is excluded from shared stories and attention counts.

## What the model does

Two small jobs, both on Claude Haiku, both optional:

1. **Translate.** New headlines go to the model in batches of 40 per country, with the edition named so unnamed places resolve correctly. It returns an English headline and the ISO codes of the countries each headline is about. Results are cached by article link in `cache/headlines.json`, pruned after 48 hours out of every feed, so a headline is never translated twice.
2. **Group shared stories.** One call per run receives every translated headline with its country code and returns groups that describe the same event in at least two countries, each with a short neutral title. Groups are validated: bad indices and single-country groups are dropped.

The "who reads about whom" counts come from the translation step's country codes and need no extra call. A run makes at most 250 model calls; the first run for 52 countries makes about 53, later runs far fewer. If the model call fails, untranslated headlines are retried next run and the previous `shared.json` is kept.

Set `ANTHROPIC_API_KEY` to enable the model. `GLOBAL_VIEW_MODEL` overrides the model id.

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
| `public/data/history/` | One small snapshot per day plus an index, for the time machine |
| `cache/headlines.json` | Translation cache, committed so runs on GitHub Actions share it |

## Shared stories across runs

Grouping is redone every run, so each new story is matched against the previous file by article overlap. When at least half of the smaller story's articles match, the old id, title and first-seen time are kept; otherwise the story starts now. This keeps `?story=` links and titles stable while the news moves on.

## Daily archive

Every run writes `public/data/history/<YYYY-MM-DD>.json`: the top five articles of each local-edition country and the ten most-shared stories, as last seen that UTC day. `history/index.json` lists the days. The site's day control steps through them. `npx tsx pipeline/snapshot.ts` writes today's snapshot from the data already on disk without fetching.

## Tests

```bash
npm test
```

Every pipeline function has a test next to it (`*.test.ts`). Network calls are mocked. The tests also check that every country in `data/countries.json` exists in the globe's shapes.
