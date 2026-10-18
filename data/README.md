# Hand-written data

## countries.json

One entry per country the site can show. The pipeline reads this file; the website never does.

| Field | Meaning |
| --- | --- |
| `code` | ISO 3166-1 alpha-2 code. Must exist in `public/geo/countries.geojson`, or the country cannot be clicked or searched |
| `name` | Display name used in logs and the index |
| `enabled` | Whether the pipeline fetches this country |
| `edition.hl` | Google News interface language, e.g. `th` or `en-GB` |
| `edition.gl` | Google News country, normally the same as `code` |
| `edition.ceid` | Google News edition id, e.g. `TH:th`. Google only publishes feeds for the editions it offers; an unsupported one redirects instead of answering |

To add a country, add an entry here and run `npm run pipeline:update -- --countries XX` to check the feed answers. The test suite checks that every code exists in the globe's shapes.
