# Global View

A light, clean website with an interactive globe. Click a country to see the most popular news stories there right now, each linking to its publisher. Countries without a local news edition show recent world coverage about them instead, clearly labelled. Headlines stay in the country's language with an English translation underneath. Arcs on the globe join countries reading the same story, and each country's panel shows who it is reading about and who is reading about it.

The site is a static Next.js export. A GitHub Actions job refreshes the data every three hours from each country's Google News top-stories feed, translates new headlines with the Claude API, and commits the results to `public/data`; Netlify redeploys on every commit. The website never calls an API.

## Develop

```bash
npm install
npm run dev          # site at http://localhost:3000
npm test             # pipeline and helper tests
npm run pipeline:update -- --countries TH   # refresh one country's data locally
npm run pipeline:update -- --no-ai          # feeds only, no model calls
```

## Build

```bash
npm run build        # writes the static site to /out
```

## Layout

| Path | What it is |
| --- | --- |
| `src/` | The website |
| `pipeline/` | The update script and its tests (see `pipeline/README.md`) |
| `data/countries.json` | Which countries are shown and which Google News edition each uses |
| `public/data/` | Generated article lists, shared stories and attention counts the site reads; written by the pipeline |
| `cache/headlines.json` | Translations already made, keyed by article link, so nothing is translated twice |
| `public/geo/countries.geojson` | Natural Earth 110m country shapes (public domain), slimmed down |
| `.github/workflows/update-news.yml` | The three-hourly update job |
