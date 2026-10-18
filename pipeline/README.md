# Pipeline

Everything that fetches and labels news lives here and runs in GitHub Actions. The website never calls an API; it only reads the JSON this pipeline writes into `public/data`.

## Steps

| Script | Phase | What it does |
| --- | --- | --- |
| `npm run pipeline:fetch` | 4 | Fetches recent articles for each enabled country from the GDELT DOC 2.0 API and writes cleaned lists to `pipeline/out/raw/<CODE>.json` |

Later phases add labelling, story grouping and publishing.

## Fetch

```bash
npm run pipeline:fetch                       # every enabled country in data/countries.json
npm run pipeline:fetch -- --countries TH     # just Thailand, enabled or not
npm run pipeline:fetch -- --countries TH,GB --timespan 6h --max 50
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--countries` | all enabled | Comma-separated ISO codes to fetch |
| `--timespan` | `12h` | How far back GDELT looks |
| `--max` | `75` | Records requested per country (GDELT caps at 250) |
| `--delay` | `5000` | Milliseconds to wait between requests; GDELT asks for at least 5000 |
| `--out` | `pipeline/out/raw` | Where raw results go |

Set `GDELT_ENDPOINT` to point the script at a local stand-in server when testing without the network.

GDELT answers rate limits and errors with plain text, so a request that does not come back as JSON counts as a failure. Each country gets one retry after the delay; if both attempts fail the country is skipped and the run continues. If every country fails the script exits non-zero and writes nothing.

Cleaning drops, in this order: articles with no headline or URL, domains on `pipeline/config/non-news-domains.json` (subdomains included), and duplicates by URL or by normalised headline (case, punctuation and spacing ignored).

## Country codes

GDELT filters by FIPS country code, not ISO, so each entry in `data/countries.json` carries a `gdelt` code: the United Kingdom is `UK`, China is `CH`. The full list is in `pipeline/data/gdelt-countries.txt` (from `http://data.gdeltproject.org/api/v2/guides/LOOKUP-COUNTRIES.TXT`) and the fetch script refuses to run with a code that is not on it.

## Tests

```bash
npm test
```

Every pipeline function has a test next to it (`*.test.ts`). Network calls are mocked.
