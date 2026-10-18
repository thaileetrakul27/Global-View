# Hand-written data

These two files are edited by hand. The pipeline reads them; the website never does.

## countries.json

One entry per country the pipeline may fetch.

| Field | Meaning |
| --- | --- |
| `code` | ISO 3166-1 alpha-2 code, matching `public/geo/countries.geojson` |
| `gdelt` | The country code GDELT uses, from `pipeline/data/gdelt-countries.txt`. GDELT uses FIPS codes, so the United Kingdom is `UK` and China is `CH`. Defaults to `code` when omitted |
| `name` | Display name |
| `enabled` | Whether the pipeline fetches this country |
| `axis.summary` | One plain-words line describing the -2 to +2 axis for this country |
| `axis.left` | Short word for the -2 end, used in labels such as "Leans reformist" |
| `axis.right` | Short word for the +2 end, used in labels such as "Leans conservative" |

Countries without a considered axis should use the generic "Critical of government to supportive of government" until someone who knows the country can check it.

## sources.json

One entry per outlet domain. Empty until outlets are rated by hand. An outlet with no entry shows as "Unrated" on the site, never a guess.

```json
{
  "domain": "example.co.th",
  "country": "TH",
  "rating": 1,
  "ownership": "independent",
  "note": "Optional short note on why"
}
```

`rating` is -2 to +2 on that country's axis. `ownership` is one of `state-owned`, `party-linked`, `independent`.

The sample files currently in `public/data` use reserved `.example` domains and invented stories so the interface can be built before the pipeline exists. They contain no ratings of real outlets.
