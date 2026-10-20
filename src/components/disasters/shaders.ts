// GLSL for the animated disaster areas. Every pattern is computed from the
// fragment's position on the sphere, so it runs continuously across the
// triangles of a mesh and across the separate zones of one disaster.
//
// Two kinds of pattern are mixed:
// - textures (water, flames, cracks, haze) keep a steady size on screen at
//   any zoom by blending two neighbouring power-of-two scales (see lod());
// - centred patterns (quake pulses, storm spirals, tsunami rings) are tied to
//   the disaster's centre and its size in km (uWave, uExtent).
//
// Cost matters: every main() first drops fragments past the horizon, and
// textures evaluate a second octave only where two octaves blend.
import type { DisasterType } from "@/lib/data";

/** Which shader each kind of disaster uses. */
export type EffectName =
  | "water"
  | "fire"
  | "shaking"
  | "wind"
  | "lava"
  | "drought"
  | "landslide"
  | "heat"
  | "cold"
  | "dust"
  | "tsunami";

export const EFFECT_FOR: Record<DisasterType, EffectName> = {
  flood: "water",
  wildfire: "fire",
  earthquake: "shaking",
  cyclone: "wind",
  storm: "wind",
  volcano: "lava",
  drought: "drought",
  landslide: "landslide",
  heatwave: "heat",
  coldwave: "cold",
  dust: "dust",
  tsunami: "tsunami",
};

// Effects are drawn without a depth test so they show over a lifted
// (selected) country; vFacing hides whatever lies past the horizon instead.
// The globe is convex, so a point faces the camera exactly when it is visible.
const FACING = /* glsl */ `
varying float vFacing;
void setFacing(vec3 objectPosition) {
  vec3 world = (modelMatrix * vec4(objectPosition, 1.0)).xyz;
  vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vFacing = dot(normalize(world - centre), normalize(cameraPosition - world));
}
`;

export const AREA_VERTEX = /* glsl */ `
varying vec3 vDir;
${FACING}
void main() {
  vDir = position; // normalised per fragment, which keeps small areas precise
  setFacing(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Uniforms, noise and helpers shared by every effect. */
const COMMON = /* glsl */ `
uniform float uTime;      // seconds, shared by all effects
uniform float uDpr;       // device pixels per CSS pixel
uniform float uHighlight; // eased: 1 selected, 0 normal, -1 dimmed
uniform float uStrength;  // 0..1, the zone's intensity
uniform float uOpacity;   // overall opacity: severity, approximate areas fainter
uniform float uSeed;      // 0..1 per area
uniform float uSpin;      // +1 northern hemisphere (anticlockwise storms), -1 southern
uniform float uEdge;      // km from the centre where a halo has faded out; 0 for a hard edge
uniform float uExtent;    // km from the centre to the farthest edge of the disaster
uniform float uWave;      // km between centred waves
uniform vec3 uColor;      // the type's strong colour
uniform vec3 uLight;      // the type's pale colour
uniform vec3 uCenter;     // unit vector of the disaster's position
uniform vec3 uEast;       // tangent unit vectors at the centre
uniform vec3 uNorth;
varying vec3 vDir;
varying float vFacing;

#define TAU 6.28318530718
const float EARTH_KM = 6371.0;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Three octaves of value noise, rescaled to roughly 0..1 with mean 0.5.
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return v / 0.875;
}

// Distances to the nearest and second-nearest points of a jittered grid
// (Worley noise). Their difference is near 0 along cell borders.
vec2 cells(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}

// Rotates a vector anticlockwise by a radians.
mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

// The fragment's position in km on a flat map centred on the disaster
// (east = x, north = y), measured along the surface.
vec2 localKm() {
  vec3 d = normalize(vDir);
  vec2 q = vec2(dot(d, uEast), dot(d, uNorth));
  float s = length(q);
  float ang = atan(s, dot(d, uCenter));
  return s > 1e-12 ? q * (ang * EARTH_KM / s) : vec2(0.0);
}

// Km per pattern unit at two neighbouring octaves, chosen so a unit spans
// about unitPx CSS pixels on screen, and the weight of the coarser one (z).
// The blend is narrowed to the middle of each octave, so most fragments
// evaluate one octave: callers skip the side whose weight is 0.
vec3 lod(vec2 pKm, float unitPx) {
  float kmPerPx = max(max(length(dFdx(pKm)), length(dFdy(pKm))), 1e-6) * uDpr;
  float l = log2(kmPerPx * unitPx);
  float l0 = floor(l);
  return vec3(exp2(l0), exp2(l0 + 1.0), smoothstep(0.3, 0.7, l - l0));
}

// 0 while an area is only a pattern cell or two across (it would read as a
// glitch, not a texture), 1 once it spans several.
float detail(vec3 s) {
  return smoothstep(1.5, 5.0, uExtent / s.x);
}

// A travelling pulse with a sharp front and a soft tail. Pulses too fine to
// draw at this zoom fade to their average instead of shimmering.
float pulseWave(float phase, float avg) {
  float w = fract(phase);
  float p = smoothstep(0.0, 0.07, w) * (1.0 - smoothstep(0.07, 0.5, w));
  return mix(p, avg, smoothstep(0.12, 0.45, fwidth(phase)));
}

// Selection emphasis, the overall opacity, a halo's soft edge and a fade
// towards the horizon. Fragments past the horizon were dropped by main().
vec4 finish(vec3 col, float a) {
  if (uEdge > 0.0) a *= 1.0 - smoothstep(0.5 * uEdge, uEdge, length(localKm()));
  float sel = clamp(uHighlight, 0.0, 1.0);
  float dim = clamp(-uHighlight, 0.0, 1.0);
  a *= uOpacity * (1.0 + 0.4 * sel) * (1.0 - 0.6 * dim) * smoothstep(0.0, 0.15, vFacing);
  col = mix(col, col * 0.88, 0.35 * sel);
  return vec4(col, clamp(a, 0.0, 0.9));
}
`;

/** Each effect's own functions and main(). */
const EFFECTS: Record<EffectName, string> = {
  // Flood: translucent water with ripples, a moving web of caustic light and
  // slow fronts spreading out from the centre.
  water: /* glsl */ `
float caustic(vec2 uv, float t) {
  // After Dave Hoskins' tileable water caustic.
  vec2 p = mod(uv * TAU, TAU) - 250.0;
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(1.3 * pow(abs(c), 5.0), 0.0, 1.0);
}

vec2 water(vec2 uv, float t) {
  float w = vnoise(uv * 0.8 + vec2(t * 0.3, -t * 0.22));
  // Two wave trains crossing, so the surface reads as choppy water.
  float a = sin(dot(uv, vec2(0.83, 0.55)) * 4.2 - t * 1.7 + w * 3.5);
  float b = sin(dot(uv, vec2(-0.45, 0.89)) * 3.1 - t * 1.2 + w * 2.5);
  float ripple = 0.5 + 0.25 * (a + b);
  float glint = caustic(uv * 0.5 + uSeed * 3.0, t * 0.45);
  return vec2(ripple, glint);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 26.0);
  vec2 m = vec2(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * water(p / s.x, t);
  if (s.z > 0.0) m += s.z * water(p / s.y, t);
  float front = pulseWave(length(p) / uWave * 0.6 - t * 0.12, 0.2);
  float crest = smoothstep(0.78, 0.97, m.x); // sun on the tops of the waves
  // Mostly the flood's own blue, so the water never greys out on pale land;
  // the caustic light is capped so it glints rather than frosts.
  vec3 col = mix(uColor * 0.8, uLight, 0.05 + 0.4 * m.x);
  col = mix(col, vec3(1.0), clamp(0.6 * m.y + 0.2 * crest, 0.0, 0.55));
  float a = 0.46 + 0.1 * uStrength + 0.1 * m.x + 0.24 * m.y + 0.08 * crest + 0.08 * front;
  gl_FragColor = finish(col, a);
}
`,

  // Wildfire: flickering flame noise from deep red to yellow, with embers.
  fire: /* glsl */ `
vec3 fire(vec2 uv, float t) {
  // Stretched upwards so the noise licks like flames.
  vec2 q = vec2(uv.x * 1.1, uv.y * 0.6) + uSeed * 19.0;
  float n1 = fbm(q * 0.9 + vec2(0.0, -t * 1.1));
  float n2 = fbm(q * 1.8 + vec2(n1 * 1.6, -t * 2.0));
  float flame = smoothstep(0.38, 0.86, 0.75 * n2 + 0.45 * n1);
  // Embers: a spark in some cells, drifting and blinking.
  vec2 eg = uv * 1.3 + vec2(0.3 * sin(t * 0.4 + uSeed * 6.0), -t * 0.35);
  vec2 cell = floor(eg);
  vec2 o = hash22(cell + 3.7);
  float d = length(fract(eg) - (0.2 + 0.6 * o));
  float blink = pow(max(0.0, sin(t * (1.5 + 2.5 * o.x) + o.y * TAU)), 4.0);
  float ember = smoothstep(0.11, 0.0, d) * blink * step(0.6, hash12(cell + 11.0));
  return vec3(flame, ember, n1);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 28.0);
  vec3 m = vec3(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * fire(p / s.x, t);
  if (s.z > 0.0) m += s.z * fire(p / s.y, t);
  float flicker = 0.84 + 0.16 * sin(t * 11.0 + m.z * 9.0) * sin(t * 7.3 + uSeed * 5.0);
  float f = m.x * flicker;
  // Smouldering ground, orange flames, yellow-white tips.
  vec3 smoulder = mix(uColor, vec3(0.22, 0.06, 0.03), 0.5);
  vec3 col = mix(smoulder, vec3(0.97, 0.36, 0.06), smoothstep(0.08, 0.5, f));
  col = mix(col, vec3(1.0, 0.7, 0.2), smoothstep(0.5, 0.85, f));
  col = mix(col, vec3(1.0, 0.92, 0.55), smoothstep(0.88, 1.0, f));
  col = mix(col, vec3(1.0, 0.93, 0.6), m.y);
  float a = 0.3 + 0.08 * uStrength + 0.55 * smoothstep(0.05, 0.6, f);
  a = max(a, 0.95 * m.y);
  gl_FragColor = finish(col, a);
}
`,

  // Earthquake shaking: warm pulses running outward from the epicentre,
  // deeper and stronger in the higher-intensity zones, with a slight tremor.
  shaking: /* glsl */ `
void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec2 tremor = vec2(vnoise(vec2(t * 23.0, uSeed * 50.0)), vnoise(vec2(uSeed * 50.0 + 9.0, t * 21.0))) - 0.5;
  float r = length(p + tremor * uWave * 0.05 * uStrength);
  float pulse = pulseWave(r / uWave - t * 0.7, 0.25);
  pulse *= 1.0 - 0.45 * smoothstep(0.6, 1.0, r / uExtent);
  vec3 fill = mix(uLight, uColor, 0.3 + 0.6 * uStrength);
  vec3 col = mix(fill, uColor * 0.78, 0.75 * pulse);
  float a = 0.16 + 0.3 * uStrength + pulse * (0.24 + 0.36 * uStrength);
  gl_FragColor = finish(col, a);
}
`,

  // Cyclones and storms: cloud bands wound into a spiral around the storm
  // centre and turning with it (anticlockwise in the north), with a clear eye.
  wind: /* glsl */ `
vec2 clouds(vec2 uv) {
  return vec2(fbm(uv * 0.5), fbm(uv * 1.3 + 7.0));
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  float r = length(p);
  float lr = log(max(r, 1.0));
  float spin = t * 0.3;
  // Three arms wound into a log spiral, so they look right at any size.
  float twist = 2.2 * lr - spin;
  float arms = 0.5 + 0.5 * sin(3.0 * (uSpin * atan(p.y, p.x) + twist));
  vec2 w = rot(uSpin * twist) * p;
  vec3 s = lod(p, 40.0);
  vec2 c = vec2(0.0);
  if (s.z < 1.0) c += (1.0 - s.z) * clouds(w / s.x);
  if (s.z > 0.0) c += s.z * clouds(w / s.y);
  float cloud = 0.7 * c.x + 0.3 * c.y;
  float band = smoothstep(0.42, 0.85, 0.62 * arms + 0.55 * cloud);
  float eye = smoothstep(14.0, 38.0, r);
  float edge = 1.0 - 0.35 * smoothstep(0.7, 1.0, r / uExtent);
  vec3 col = mix(uLight, uColor, 0.35 + 0.25 * uStrength + 0.3 * band);
  col = mix(col, vec3(1.0), 0.25 * band * cloud);
  // Wind bands are drawn as rings (each inner band cut out of the one
  // around it), so each band carries its full strength on its own.
  float a = (0.07 + 0.14 * uStrength) + band * (0.22 + 0.4 * uStrength);
  gl_FragColor = finish(col, a * eye * edge);
}
`,

  // Volcano: a lava-red glow pulsing out from the vent with bright veins.
  lava: /* glsl */ `
vec2 lava(vec2 uv, float t) {
  float n = fbm(uv * 0.7 + vec2(t * 0.05, -t * 0.03));
  float vein = pow(clamp(1.0 - abs(n * 2.0 - 0.95), 0.0, 1.0), 6.0);
  return vec2(vein, n);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 30.0);
  vec2 m = vec2(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * lava(p / s.x, t);
  if (s.z > 0.0) m += s.z * lava(p / s.y, t);
  float glow = 1.0 - smoothstep(0.0, 1.0, length(p) / uExtent);
  float pulse = 0.5 + 0.5 * sin(t * 1.8 - length(p) / uWave * 2.5);
  // Dark cooled rock, glowing orange towards the vent and along the veins.
  vec3 rock = mix(uColor, vec3(0.18, 0.05, 0.04), 0.45);
  vec3 lava = mix(vec3(0.95, 0.3, 0.05), vec3(1.0, 0.76, 0.26), m.x);
  float heat = clamp(0.6 * glow * (0.55 + 0.45 * pulse) + m.x, 0.0, 1.0);
  vec3 col = mix(rock, lava, heat);
  float a = 0.3 + 0.3 * glow + 0.3 * m.x;
  gl_FragColor = finish(col, a);
}
`,

  // Drought: parched ochre ground split by a network of cracks, under a slow
  // heat shimmer. Cracks fade out while the area is only a few cells across.
  drought: /* glsl */ `
// Distance to the nearest cell border of a Voronoi pattern (after Inigo
// Quilez). The second pass looks at the 3 x 3 cells around the nearest
// point rather than 5 x 5: half the cost, with rare, faint flaws.
float voronoiEdge(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + hash22(n + g) - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}

vec2 cracks(vec2 uv, float t) {
  vec2 haze = vec2(vnoise(uv * 0.45 + vec2(t * 0.12, 0.0)), vnoise(uv * 0.45 + vec2(5.0, t * 0.1))) - 0.5;
  float e = voronoiEdge(uv * 0.75 + haze * 0.1);
  return vec2(1.0 - smoothstep(0.015, 0.06, e), vnoise(uv * 0.3));
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 34.0);
  vec2 m = vec2(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * cracks(p / s.x, t);
  if (s.z > 0.0) m += s.z * cracks(p / s.y, t);
  m.x *= detail(s);
  float shimmer = 0.5 + 0.5 * sin(p.y / uWave * 2.0 + t * 0.6 + 4.0 * vnoise(p / uWave));
  vec3 ground = mix(uLight, uColor, 0.4 + 0.25 * m.y);
  ground = mix(ground, uLight, 0.15 * shimmer);
  vec3 col = mix(ground, uColor * 0.62, m.x);
  float a = 0.26 + 0.08 * uStrength + 0.06 * shimmer + 0.3 * m.x;
  gl_FragColor = finish(col, a);
}
`,

  // Landslide: brown streaks sliding slowly downslope.
  landslide: /* glsl */ `
vec2 streaks(vec2 uv, float t) {
  vec2 q = rot(uSeed * TAU) * uv;
  float n = vnoise(vec2(q.x * 2.2, q.y * 0.25 - t * 0.35));
  float n2 = vnoise(vec2(q.x * 4.5 + 3.0, q.y * 0.5 - t * 0.6));
  return vec2(smoothstep(0.5, 0.85, 0.65 * n + 0.45 * n2), n);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 30.0);
  vec2 m = vec2(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * streaks(p / s.x, t);
  if (s.z > 0.0) m += s.z * streaks(p / s.y, t);
  vec3 col = mix(uLight, uColor, 0.45 + 0.45 * m.x);
  float a = 0.28 + 0.08 * uStrength + 0.42 * m.x;
  gl_FragColor = finish(col, a);
}
`,

  // Heatwave: a red-orange shimmer of rising heat.
  heat: /* glsl */ `
vec2 heat(vec2 uv, float t) {
  float n = fbm(uv * 0.5 + vec2(t * 0.06, t * 0.1));
  return vec2(0.5 + 0.5 * sin(uv.y * 1.6 + n * 5.0 - t * 1.0), n);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 36.0);
  vec2 m = vec2(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * heat(p / s.x, t);
  if (s.z > 0.0) m += s.z * heat(p / s.y, t);
  vec3 base = mix(uColor, vec3(0.92, 0.3, 0.1), 0.55);
  vec3 col = mix(base, vec3(0.98, 0.6, 0.18), 0.15 + 0.65 * m.x);
  float a = 0.26 + 0.1 * uStrength + 0.24 * m.x + 0.08 * m.y;
  gl_FragColor = finish(col, a);
}
`,

  // Cold wave: icy blue frost with crystal facets and twinkling sparkles.
  cold: /* glsl */ `
vec3 frost(vec2 uv, float t) {
  float f = fbm(uv * 0.6);
  vec2 c = cells(uv * 0.9 + 3.0);
  float facet = 1.0 - smoothstep(0.0, 0.07, c.y - c.x);
  vec2 g = uv * 1.1;
  vec2 cell = floor(g);
  vec2 o = hash22(cell + 5.1);
  vec2 d = fract(g) - (0.2 + 0.6 * o);
  float star = smoothstep(0.1, 0.0, length(d))
    + max(smoothstep(0.04, 0.0, abs(d.x)) * smoothstep(0.32, 0.0, abs(d.y)),
          smoothstep(0.04, 0.0, abs(d.y)) * smoothstep(0.32, 0.0, abs(d.x)));
  float twinkle = pow(max(0.0, sin(t * (1.0 + 2.0 * o.y) + o.x * TAU)), 4.0) * step(0.45, hash12(cell));
  return vec3(f, facet, clamp(star, 0.0, 1.0) * twinkle);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 30.0);
  vec3 m = vec3(0.0);
  if (s.z < 1.0) m += (1.0 - s.z) * frost(p / s.x, t);
  if (s.z > 0.0) m += s.z * frost(p / s.y, t);
  m.yz *= detail(s);
  vec3 col = mix(uLight, uColor, 0.25 + 0.5 * m.x);
  col = mix(col, vec3(1.0), clamp(0.55 * m.y + m.z, 0.0, 1.0));
  float a = 0.24 + 0.08 * uStrength + 0.18 * m.x + 0.22 * m.y + 0.6 * m.z;
  gl_FragColor = finish(col, a);
}
`,

  // Dust storm: tan haze drifting with the wind.
  dust: /* glsl */ `
float haze(vec2 uv, float t) {
  vec2 drift = vec2(t * 0.3, t * 0.06);
  float n = fbm(uv * 0.45 - drift);
  return fbm(uv * 1.1 - drift * 1.8 + n * 1.5);
}

void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  vec3 s = lod(p, 40.0);
  float n = 0.0;
  if (s.z < 1.0) n += (1.0 - s.z) * haze(p / s.x, t);
  if (s.z > 0.0) n += s.z * haze(p / s.y, t);
  vec3 col = mix(uLight, uColor, 0.2 + 0.55 * n);
  float a = 0.16 + 0.08 * uStrength + 0.4 * smoothstep(0.3, 0.75, n);
  gl_FragColor = finish(col, a);
}
`,

  // Tsunami: deep blue wave crests racing out from the source.
  tsunami: /* glsl */ `
void main() {
  if (vFacing <= 0.0) discard;
  vec2 p = localKm();
  float t = uTime;
  float crest = pulseWave(length(p) / uWave * 1.2 - t * 0.45, 0.22);
  crest *= 1.0 - 0.4 * smoothstep(0.6, 1.0, length(p) / uExtent);
  vec3 col = mix(uColor, uLight, 0.15 + 0.55 * crest);
  float a = 0.26 + 0.1 * uStrength + 0.45 * crest;
  gl_FragColor = finish(col, a);
}
`,
};

/** The complete fragment shader for one effect. */
export function areaFragment(effect: EffectName): string {
  return COMMON + EFFECTS[effect];
}

/** Outlines: a thin edge in the type's colour, dashed for approximate areas. */
export const OUTLINE_VERTEX = /* glsl */ `
attribute float aDist;
varying float vDist;
${FACING}
void main() {
  vDist = aDist;
  setFacing(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const OUTLINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uHighlight;
uniform float uOpacity;
uniform float uDash; // km per dash and gap; 0 for a solid line
varying float vDist;
varying float vFacing;
void main() {
  if (vFacing <= 0.0) discard;
  if (uDash > 0.0 && fract(vDist / uDash) > 0.55) discard;
  float sel = clamp(uHighlight, 0.0, 1.0);
  float dim = clamp(-uHighlight, 0.0, 1.0);
  float a = uOpacity * (0.4 + 0.4 * sel) * (1.0 - 0.65 * dim) * smoothstep(0.0, 0.15, vFacing);
  gl_FragColor = vec4(uColor, a);
}
`;
