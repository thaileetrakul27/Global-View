# Global View
A light, clean website with an interactive globe. Clicking a country shows its top news stories, grouped by event, with each article labelled on that country's own political spectrum.

## Rules
- Next.js with TypeScript, static export only (output: 'export'). No server code in the website.
- Tailwind CSS. Light theme only. Background #FAFAF7, white cards, grey borders, no heavy shadows.
- Spectrum colours: teal (-2, -1), grey (0), amber (+1, +2). Never red and blue.
- The website reads only JSON from public/data. All fetching and labelling lives in /pipeline and runs in GitHub Actions.
- Never invent a bias rating. Missing data shows as "Unrated" or "Unclear".
- Mobile layout must work at 375px wide.
- Keep components small and commented. Write a test for every pipeline function.
