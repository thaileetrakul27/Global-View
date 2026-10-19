# Global View
A light, clean website with an interactive globe. Clicking a country lists the most popular news stories in that country right now, with a link to each publisher.

## Rules
- Next.js with TypeScript, static export only (output: 'export'). No server code in the website.
- Tailwind CSS. Light theme only. Background #FAFAF7, white cards, grey borders, no heavy shadows.
- The website reads only JSON from public/data. All fetching lives in /pipeline and runs in GitHub Actions.
- "Most popular" means the top stories feed of that country's Google News edition. Countries with no edition get "world coverage" instead: a Bing News search in the country's own press language (pipeline/config/languages.json) for what its own outlets publish, followed by a Google News search in English, clearly labelled as a search, drawn a shade paler on the globe, and left out of shared stories and "who reads about whom". Show headline, outlet, time and link only. Never store or republish article text.
- The Claude API (Haiku) is used for exactly two things: translating headlines into English and noting which countries they are about, and grouping headlines that describe the same event across countries. Each headline is translated once and cached by link in cache/headlines.json. Nothing else is sent to a model.
- Every model call is optional. Without ANTHROPIC_API_KEY, or with --no-ai, the feeds still publish and the previous shared-story file is kept.
- A failed fetch keeps the previous data for that country; nothing is ever replaced with an empty list.
- Humanitarian signals (public/data/crises.json) come from two places: verified Orange and Red disaster alerts from the public-domain GDACS feed (UN and European Commission), and estimates from headline keywords, which are shown as estimates. Where help is needed and where to give (public/data/help.json) comes only from official registries: each country's own Red Cross or Red Crescent society, the active appeals and the emergencies behind them from IFRC's GO platform, and UN response plans with their funding from OCHA's Financial Tracking Service. Donation pages are found by fixed rules, never by hand: the society's page on IFRC's Red Cross Red Crescent donation platform (probed by URL) and UN Crisis Relief's per-crisis pages (from its sitemap), falling back to the society's own site and UN Crisis Relief's general fund. Long-term needs (public/data/needs.json) are UN figures republished by the World Bank's open data API: water, sanitation, electricity, hunger, poverty, schooling, literacy and child mortality, each with its year and source, and a fixed table of UN agency donation pages by kind of need (src/lib/needs.ts). Every country shows its biggest current crisis, chosen by a fixed score in src/lib/crisis.ts, its long-term needs, and these pages. The site never chooses charities itself, never takes donations, and no model picks a link.
- Mobile layout must work at 375px wide.
- Keep components small and commented. Write a test for every pipeline function.

## Out of scope for now
Bias labelling was removed from the plan. Do not reintroduce outlet ratings, spectrum colours or AI bias labelling without being asked.
