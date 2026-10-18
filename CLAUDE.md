# Global View
A light, clean website with an interactive globe. Clicking a country lists the most popular news stories in that country right now, with a link to each publisher.

## Rules
- Next.js with TypeScript, static export only (output: 'export'). No server code in the website.
- Tailwind CSS. Light theme only. Background #FAFAF7, white cards, grey borders, no heavy shadows.
- The website reads only JSON from public/data. All fetching lives in /pipeline and runs in GitHub Actions.
- "Most popular" means the top stories feed of that country's Google News edition. Show headline, outlet, time and link only. Never store or republish article text.
- A failed fetch keeps the previous data for that country; nothing is ever replaced with an empty list.
- Mobile layout must work at 375px wide.
- Keep components small and commented. Write a test for every pipeline function.

## Out of scope for now
Bias labelling and story grouping were removed from the plan. Do not reintroduce ratings, spectrum colours or AI labelling without being asked.
