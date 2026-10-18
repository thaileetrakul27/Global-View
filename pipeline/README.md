# Pipeline

Fetches each country's most popular articles and writes the JSON the website reads into `public/data`. It runs in GitHub Actions every three hours (`.github/workflows/update-news.yml`). The website never calls an API.

## What "most popular" means

The top stories feed of that country's Google News edition. Each run keeps up to 30 articles per country, in Google's order, after removing duplicate headlines. No article text is fetched or stored; the site shows headlines, outlet names, times and links.

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

Set `NEWS_FEED_ENDPOINT` to point the script at a local stand-in server when testing without the network.

## Failure behaviour

Each feed gets one retry. A country that fails twice keeps its previous file and its previous index entry, so the site shows slightly older stories for it rather than nothing. The run exits non-zero only if every country fails, in which case nothing is written and the workflow commits nothing.

## Output

| File | Holds |
| --- | --- |
| `public/data/index.json` | When the pipeline last ran, and per country the name, article count and refresh time. Colours the globe |
| `public/data/countries/TH.json` | That country's articles: title, link, outlet, outlet site, publish time |

## Tests

```bash
npm test
```

Every pipeline function has a test next to it (`*.test.ts`). Network calls are mocked. The tests also check that every country in `data/countries.json` exists in the globe's shapes.
