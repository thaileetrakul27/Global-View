# Global View
A light, clean website with an interactive globe. Clicking a country lists the most popular news stories in that country right now, with a link to each publisher.

## Rules
- Next.js with TypeScript, static export only (output: 'export'). No server code in the website.
- Tailwind CSS. Light theme only. Background #FAFAF7, white cards, grey borders, no heavy shadows.
- The website reads only JSON from public/data. All fetching lives in /pipeline and runs in GitHub Actions.
- "Most popular" means the top stories feed of that country's Google News edition. Countries with no edition get "world coverage" instead: a Bing News search in the country's own press language (pipeline/config/languages.json) for what its own outlets publish, followed by a Google News search in English, clearly labelled as a search, drawn a shade paler on the globe, and left out of shared stories and "who reads about whom". Show headline, outlet, time and link only. Never store or republish article text.
- The Claude API (Haiku by default) is used for exactly four things: translating headlines into English and noting which countries they are about; grouping headlines that describe the same event across countries; spotting natural disasters in the site's own headlines; and researching each ongoing disaster with web search (affected places, a short summary, key figures, candidate donation pages). Each headline is translated once and cached by link in cache/headlines.json; research is cached per disaster in cache/research.json. Nothing else is sent to a model.
- All Claude API use is capped at $50 a month. pipeline/lib/spend.ts records every call's real cost in cache/spend.json and paces web research per day; once the month's spend nears the cap, model calls stop and the feeds still publish.
- Every model call is optional. Without ANTHROPIC_API_KEY, or with --no-ai, the feeds still publish and the previous shared-story file is kept.
- A failed fetch keeps the previous data for that country; nothing is ever replaced with an empty list.
- The disaster map (public/data/disasters.json, built by pipeline/lib/disasters/) shows natural disasters that are ongoing now: earthquakes, tsunamis, cyclones, storms, floods, landslides, wildfires, volcanoes, droughts, heat and cold waves, dust storms. Sources: GDACS (UN and European Commission) with its affected-area shapes, USGS earthquakes with ShakeMap, NASA EONET, IFRC GO operations, and disasters spotted in the site's own headlines. Affected cities and districts come from the sources or from web research, and are placed with OpenStreetMap Nominatim (one request a second, cached in cache/geocode.json, credited on the site). Each disaster is drawn on the globe as an animated effect over its real area.
- Donation pages are never chosen by hand and never by a model alone. They come from official registries by fixed rule (the national Red Cross or Red Crescent society and its page on IFRC's donation platform, UN Crisis Relief's per-crisis pages), or from web research, accepted only when the page is on an allowlisted official domain (the country's own society, the UN family, IFRC/ICRC, or the country's government domains in pipeline/config/donation-domains.json) and passes a live check. The site never takes donations itself.
- Mobile layout must work at 375px wide.
- Keep components small and commented. Write a test for every pipeline function.

## Out of scope for now
Bias labelling was removed from the plan. Do not reintroduce outlet ratings, spectrum colours or AI bias labelling without being asked.
