// How the news map's reading lines are drawn at each zoom. From the world
// view they show where attention points; close in on one country, the same
// few dozen lines run off every edge of the screen as straight strokes and
// through the header, so they fade and thin as the camera comes down.

/** Camera altitude (in globe radii, the narrow-screen scale taken out) at and above which the lines are at full strength. */
export const FADE_FAR = 1.8;
/** Altitude at and below which they are faintest: about where a selected country's close-up sits. */
export const FADE_NEAR = 1;
/** Share of their normal opacity the lines keep up close. */
export const FADE_MIN = 0.2;
/** Steps from faintest to full, so the globe redraws the lines a few times per zoom, not every frame. */
const STEPS = 4;

/**
 * How strongly reading lines are drawn at a camera altitude: 1 at the world
 * view, FADE_MIN close in, and one of a few fixed values in between.
 */
export function readingFade(altitude: number): number {
  if (!Number.isFinite(altitude)) return 1;
  const t = Math.min(1, Math.max(0, (altitude - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
  return FADE_MIN + ((1 - FADE_MIN) * Math.round(t * STEPS)) / STEPS;
}

/**
 * A reading line's colour opacity and width in screen pixels, for its
 * strength (0..1) at a fade from readingFade. Unfaded, stronger lines are
 * brighter and thicker; faded, they keep a fifth of the opacity and lose a
 * third of the width.
 */
export function readingLook(strength: number, fade: number): { alpha: number; width: number } {
  return { alpha: (0.3 + 0.45 * strength) * fade, width: (1 + strength) * (0.6 + 0.4 * fade) };
}
