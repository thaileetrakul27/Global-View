// Builds the animated meshes for disaster areas and keeps their shared
// uniforms ticking. One AreaEffects instance serves the whole globe.
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  type Camera,
  type IUniform,
  type Intersection,
  type Object3D,
  type Raycaster,
  type Scene,
  type WebGLRenderer,
} from "three";
import ConicPolygonGeometry from "three-conic-polygon-geometry";
import type { Position } from "@/lib/data";
import { DISASTER_META } from "@/lib/disasterMeta";
import { EARTH_RADIUS_KM, centredWaveKm, type AreaItem } from "@/lib/disasterLayers";
import { AREA_VERTEX, EFFECT_FOR, OUTLINE_FRAGMENT, OUTLINE_VERTEX, areaFragment, type EffectName } from "./shaders";

/** Interior points every this many degrees, so big areas follow the globe's curve. */
const CURVATURE_RESOLUTION = 1.5;
/** Outlines float this much (globe radii) above their fill. */
const OUTLINE_LIFT = 0.0002;
/**
 * Pointer hits on an effect count as this much nearer the camera (scene
 * units; the globe's radius is 100), so an area still wins the click over a
 * selected country lifted 0.65 units above it.
 */
const RAYCAST_BIAS = 1;
/** Time shown when motion is reduced: an arbitrary, natural-looking frame. */
const STILL_TIME = 7.3;
/**
 * Animation time wraps after this many seconds, so fast terms such as
 * sin(t * 11) keep their float precision in a tab left open for days. The
 * patterns jump once an hour.
 */
const TIME_WRAP = 3600;
/** The globe's radius in scene units (three-globe's fixed value). */
const GLOBE_RADIUS = 100;
/** Extra reach (radians) when culling, for effects lifted a little above the surface. */
const CULL_MARGIN = 0.03;
/** Opacity of the soft halo under small or unmapped disasters, relative to a mapped area. */
const HALO_OPACITY = 0.7;
/** Circles around named places: the dashed edge says they are approximate, so they stay nearly as strong. */
const APPROXIMATE_OPACITY = 0.9;

/** One live area: its object, and the cap of the globe it covers, for culling. */
interface Entry {
  group: Group;
  /** Unit vector of the disaster's centre. */
  center: Vector3;
  /** Angular radius of the disaster's reach, radians. */
  reach: number;
}

/** A colour as raw sRGB components, matching the CSS colours exactly. */
function srgb(hex: string): Vector3 {
  const p = parseInt(hex.slice(1), 16);
  return new Vector3(((p >> 16) & 255) / 255, ((p >> 8) & 255) / 255, (p & 255) / 255);
}

/** Unit vector for a lat/lng, in three-globe's axes. */
function unit(lat: number, lng: number): Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  return new Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
}

/** Joins the meshes of a multipolygon's parts into one geometry (positions and index only). */
function mergeParts(parts: BufferGeometry[]): BufferGeometry | null {
  const live = parts.filter((g) => (g.index?.count ?? 0) > 0);
  if (!live.length) return null;
  const vertexCount = live.reduce((n, g) => n + g.getAttribute("position").count, 0);
  const indexCount = live.reduce((n, g) => n + (g.index?.count ?? 0), 0);
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  for (const g of live) {
    const pos = g.getAttribute("position");
    positions.set(pos.array as Float32Array, v * 3);
    const idx = g.index!;
    for (let k = 0; k < idx.count; k++) indices[i++] = idx.getX(k) + v;
    v += pos.count;
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(positions, 3));
  out.setIndex(new BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

/** Great-circle points between two [lng, lat] corners, at most one degree apart. */
function edgePoints(a: Position, b: Position, radius: number): Vector3[] {
  const va = unit(a[1], a[0]);
  const vb = unit(b[1], b[0]);
  const angle = va.angleTo(vb);
  const steps = Math.max(1, Math.ceil((angle * 180) / Math.PI));
  const out: Vector3[] = [];
  for (let s = 0; s <= steps; s++) {
    // Normalised lerp is close enough to a slerp at one-degree steps.
    out.push(va.clone().lerp(vb, s / steps).normalize().multiplyScalar(radius));
  }
  return out;
}

/** Line segments along every ring, with the distance along the ring in km for dashes. */
function outlineGeometry(polygons: Position[][][], radius: number): { geometry: BufferGeometry; lengthKm: number } {
  const positions: number[] = [];
  const dists: number[] = [];
  let longest = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      let dist = 0;
      for (let k = 0; k + 1 < ring.length; k++) {
        const pts = edgePoints(ring[k], ring[k + 1], radius);
        for (let s = 0; s + 1 < pts.length; s++) {
          const step = pts[s].angleTo(pts[s + 1]) * 6371;
          positions.push(pts[s].x, pts[s].y, pts[s].z, pts[s + 1].x, pts[s + 1].y, pts[s + 1].z);
          dists.push(dist, dist + step);
          dist += step;
        }
      }
      longest = Math.max(longest, dist);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("aDist", new BufferAttribute(new Float32Array(dists), 1));
  geometry.computeBoundingSphere();
  return { geometry, lengthKm: longest };
}

/** True when the object and every parent are visible (three.js raycasts hidden objects too). */
function shown(obj: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * Raycasts as usual, then reports each hit a little nearer (see
 * RAYCAST_BIAS). Hidden and culled areas take no hits.
 */
function biasedRaycast(this: Mesh | LineSegments, raycaster: Raycaster, hits: Intersection[]): void {
  if (!shown(this)) return;
  const before = hits.length;
  Object.getPrototypeOf(this).raycast.call(this, raycaster, hits);
  for (let i = before; i < hits.length; i++) hits[i].distance -= RAYCAST_BIAS;
}

export class AreaEffects {
  /** Seconds of animation, shared by every effect material. */
  readonly time: IUniform<number> = { value: STILL_TIME };
  /** Device pixel ratio, so textures keep their size in CSS pixels. */
  readonly dpr: IUniform<number> = { value: 1 };
  /** Eased highlight per disaster, shared by all of its areas and outlines. */
  private readonly highlights = new Map<string, IUniform<number>>();
  /** Every area built and not yet pruned, for culling and hiding. */
  private readonly entries = new Map<AreaItem, Entry>();
  /** False hides every area while keeping its meshes (the news map). */
  private shown = true;
  /** Scratch vector for the camera direction. */
  private readonly view = new Vector3();
  /** One compiled program per effect; meshes use clones that share it. */
  private readonly bases = new Map<EffectName, ShaderMaterial>();
  private readonly outlineBase = new ShaderMaterial({
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    uniforms: { uColor: { value: new Vector3() }, uHighlight: { value: 0 }, uOpacity: { value: 1 }, uDash: { value: 0 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });

  private highlight(id: string): IUniform<number> {
    let u = this.highlights.get(id);
    if (!u) this.highlights.set(id, (u = { value: 0 }));
    return u;
  }

  private base(effect: EffectName): ShaderMaterial {
    let m = this.bases.get(effect);
    if (!m) {
      m = new ShaderMaterial({
        vertexShader: AREA_VERTEX,
        fragmentShader: areaFragment(effect),
        uniforms: {
          uTime: { value: 0 },
          uDpr: { value: 1 },
          uHighlight: { value: 0 },
          uStrength: { value: 0.5 },
          uOpacity: { value: 1 },
          uSeed: { value: 0 },
          uSpin: { value: 1 },
          uEdge: { value: 0 },
          uExtent: { value: 100 },
          uWave: { value: 40 },
          uColor: { value: new Vector3() },
          uLight: { value: new Vector3() },
          uCenter: { value: new Vector3(0, 0, 1) },
          uEast: { value: new Vector3(1, 0, 0) },
          uNorth: { value: new Vector3(0, 1, 0) },
        },
        transparent: true,
        depthWrite: false,
        // Drawn over everything below; the shader hides the far side.
        depthTest: false,
        side: DoubleSide,
        // One pass is enough for a flat cap, and halves the cost of DoubleSide.
        forceSinglePass: true,
        blending: NormalBlending,
      });
      this.bases.set(effect, m);
    }
    return m;
  }

  /**
   * The three.js object for one area: an animated fill and, unless it is a
   * halo, a thin outline.
   */
  create(item: AreaItem, globeRadius: number): Group {
    const group = new Group();
    const meta = DISASTER_META[item.type];
    const highlight = this.highlight(item.disasterId);
    const severityOpacity = 0.85 + 0.075 * (item.severity - 1);
    const opacity = severityOpacity * (item.kind === "halo" ? HALO_OPACITY : item.approximate ? APPROXIMATE_OPACITY : 1);

    // The fill has the next stronger zone cut out; the outline follows the zone's own edge.
    const parts = item.fill.flatMap((polygon) => {
      try {
        // Exactly how three-globe builds polygon caps, at the globe's radius.
        return [new ConicPolygonGeometry(polygon, 0, globeRadius, false, true, false, CURVATURE_RESOLUTION)];
      } catch {
        return []; // a degenerate part the triangulator cannot handle
      }
    });
    const geometry = mergeParts(parts);
    parts.forEach((g) => g.dispose());
    if (geometry) {
      // Tangent frame at the centre, for the shader's flat km coordinates.
      const center = unit(item.center.lat, item.center.lng);
      const north0 = new Vector3(0, 1, 0);
      const east = new Vector3().crossVectors(north0, center);
      if (east.lengthSq() < 1e-8) east.set(1, 0, 0); // at a pole
      east.normalize();
      const north = new Vector3().crossVectors(center, east).normalize();

      const material = this.base(EFFECT_FOR[item.type]).clone();
      Object.assign(material.uniforms, {
        uTime: this.time,
        uDpr: this.dpr,
        uHighlight: highlight,
        uStrength: { value: item.intensity },
        uOpacity: { value: opacity },
        uSeed: { value: item.seed },
        uSpin: { value: item.center.lat < 0 ? -1 : 1 },
        uEdge: { value: item.softEdgeKm },
        uExtent: { value: item.extentKm },
        uWave: { value: centredWaveKm(item.extentKm) },
        uColor: { value: srgb(meta.color) },
        uLight: { value: srgb(meta.light) },
        uCenter: { value: center },
        uEast: { value: east },
        uNorth: { value: north },
      });
      const mesh = new Mesh(geometry, material);
      mesh.raycast = biasedRaycast;
      mesh.scale.setScalar(1 + item.altitude);
      mesh.renderOrder = item.renderOrder;
      group.add(mesh);
    }

    if (item.outline) {
      const outline = outlineGeometry(item.polygons, globeRadius);
      const lineMaterial = this.outlineBase.clone();
      Object.assign(lineMaterial.uniforms, {
        uColor: { value: srgb(meta.color) },
        uHighlight: highlight,
        uOpacity: { value: opacity * (item.kind === "wind" || item.kind === "shaking" ? 0.7 : 1) },
        uDash: { value: item.approximate ? Math.max(1, outline.lengthKm / 36) : 0 },
      });
      const line = new LineSegments(outline.geometry, lineMaterial);
      line.raycast = biasedRaycast;
      line.scale.setScalar(1 + item.altitude + OUTLINE_LIFT);
      line.renderOrder = -0.5; // after every fill, before arcs and tracks
      group.add(line);
    }

    group.visible = this.shown;
    this.entries.set(item, {
      group,
      center: unit(item.center.lat, item.center.lng),
      reach: item.extentKm / EARTH_RADIUS_KM + CULL_MARGIN,
    });
    return group;
  }

  /** Shows or hides every area without rebuilding meshes or recompiling shaders (culling may still hide some). */
  setShown(on: boolean): void {
    this.shown = on;
    for (const e of this.entries.values()) e.group.visible = on;
  }

  /** Forgets areas and highlights that are no longer drawn. */
  prune(items: readonly AreaItem[]): void {
    const keep = new Set(items);
    for (const item of this.entries.keys()) if (!keep.has(item)) this.entries.delete(item);
    const ids = new Set(items.map((i) => i.disasterId));
    for (const id of this.highlights.keys()) if (!ids.has(id)) this.highlights.delete(id);
  }

  /**
   * Advances the animation and eases each disaster's highlight towards its
   * target. With reduced motion the frame stays still and highlights snap.
   * Given the camera's position, also hides areas wholly past the horizon,
   * so they cost neither a draw call nor any shading.
   */
  tick(dt: number, target: (id: string) => number, reducedMotion: boolean, camera?: Vector3): void {
    if (!reducedMotion) this.time.value = (this.time.value + dt) % TIME_WRAP;
    this.dpr.value = Math.min(2, window.devicePixelRatio || 1);
    const k = reducedMotion ? 1 : Math.min(1, dt * 7);
    for (const [id, u] of this.highlights) u.value += (target(id) - u.value) * k;
    if (camera && this.shown) this.cull(camera);
  }

  /** Hides each area whose cap lies wholly beyond the horizon seen from the camera. */
  private cull(camera: Vector3): void {
    const dist = camera.length();
    if (dist <= GLOBE_RADIUS) return;
    const horizon = Math.acos(GLOBE_RADIUS / dist);
    this.view.copy(camera).divideScalar(dist);
    for (const e of this.entries.values()) {
      const visible = e.center.angleTo(this.view) < e.reach + horizon;
      if (e.group.visible !== visible) e.group.visible = visible;
    }
  }

  /**
   * Compiles the programs these areas need ahead of drawing them, without
   * blocking the page, where the browser supports parallel shader
   * compilation (elsewhere it resolves at once). Lights come from the
   * globe's scene, so the programs match the ones the real meshes ask for.
   * Resolves when they are ready.
   */
  async precompile(renderer: WebGLRenderer, camera: Camera, scene: Scene, items: readonly AreaItem[]): Promise<void> {
    // Without the extension compiling would block just the same, only sooner.
    if (!renderer.extensions.has("KHR_parallel_shader_compile")) return;
    const warm = new Group();
    const tri = new BufferGeometry();
    tri.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
    tri.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    for (const effect of new Set(items.map((i) => EFFECT_FOR[i.type]))) warm.add(new Mesh(tri, this.base(effect)));
    const line = new BufferGeometry();
    line.setAttribute("position", new BufferAttribute(new Float32Array(6), 3));
    line.setAttribute("aDist", new BufferAttribute(new Float32Array(2), 1));
    warm.add(new LineSegments(line, this.outlineBase));
    try {
      await renderer.compileAsync(warm, camera, scene);
    } finally {
      tri.dispose();
      line.dispose();
    }
  }

  /** Frees the template materials. Meshes are freed by the globe as they leave. */
  dispose(): void {
    for (const m of this.bases.values()) m.dispose();
    this.bases.clear();
    this.outlineBase.dispose();
  }
}
