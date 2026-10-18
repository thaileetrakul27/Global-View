# Global View

A light, clean website with an interactive globe. Click a country to see its top news stories, grouped by event, with each article labelled on that country's own political spectrum.

The site is a static Next.js export. All news fetching and labelling lives in `/pipeline` and runs in GitHub Actions; the website only reads JSON from `public/data`.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build   # writes the static site to /out
```

## Data

- `public/geo/countries.geojson`: Natural Earth 110m country shapes (public domain), slimmed to a code, a name and rounded coordinates.
