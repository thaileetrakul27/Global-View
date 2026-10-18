# Pipeline

Fetches each country's most popular articles and writes the JSON the website reads into `public/data`. It runs in GitHub Actions every three hours (`.github/workflows/update-news.yml`). The website never calls an API.

## What "most popular" means

The top stories feed of that country's Google News edition. Each run keeps up to 30 articles per country, in Google's order, after removing duplicate headlines. No article text is fetched or stored; the site shows headlines, outlet names, times and links.

## What the model does

Two small jobs, both on Claude Haiku, both optional:

1. **Translate.** New headlines go to the model in batches of 40 per country, with the edition named so unnamed places resolve correctly. It returns an English headline and the ISO codes of the countries each headline is about. Results are cached by article link in `cache/headlines.json`, pruned after 48 hours out of every feed, so a headline is never translated twice.
2. **Group shared stories.** One call per run receives every translated headline with its country code and returns groups that describe the same event in at least two countries, each with a short neutral title. Groups are validated: bad indices and single-country groups are dropped.

The "who reads about whom" counts come from the translation step's country codes and need no extra call. A run makes at most 120 model calls; the first run for 52 countries makes about 53, later runs far fewer. If the model call fails, untranslated headlines are retried next run and the previous `shared.json` is kept.

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
| `cache/headlines.json` | Translation cache, committed so runs on GitHub Actions share it |

## Tests

```bash
npm test
```

Every pipeline function has a test next to it (`*.test.ts`). Network calls are mocked. The tests also check that every country in `data/countries.json` exists in the globe's shapes.
