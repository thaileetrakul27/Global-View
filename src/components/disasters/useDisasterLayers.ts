"use client";

// Everything the globe needs to draw disasters: animated areas (custom
// layer), quake and volcano rings, storm tracks, markers and place labels.
// Returns props to spread onto react-globe.gl plus the hovered disaster.
//
// Order of work on load: the markers first (cheap DOM), then the effect
// shaders compile in the background, then the area meshes are built a few
// per frame, so the page never stalls behind them. Switching the layer off
// hides the meshes rather than throwing them away.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { GlobeMethods, GlobeProps as GlobeGLProps } from "react-globe.gl";
import type { Object3D } from "three";
import type { Disaster } from "@/lib/data";
import {
  CLUSTER_MIN_ALTITUDE,
  CLUSTER_ZOOM,
  MARKER_ALTITUDE,
  PATH_ALTITUDE,
  PLACE_ALTITUDE,
  RING_ALTITUDE,
  activeRings,
  buildAreaItems,
  buildMarkerItems,
  buildPathItems,
  buildPlaceItems,
  buildRingItems,
  clusterMarkers,
  highlightTarget,
  placeLabelFit,
  rgba,
  type AreaItem,
  type MarkerItem,
  type PathItem,
  type PlaceItem,
  type RingItem,
  type ScreenMarker,
} from "@/lib/disasterLayers";
import { AreaEffects } from "./areaEffects";
import {
  createMarkerElement,
  createPlaceElement,
  placeLabelWidth,
  setElementVisible,
  setMarkerCluster,
  setMarkerMerged,
  setMarkerState,
  setPlaceSide,
} from "./markers";

interface Options {
  /** The globe, for its camera, renderer and canvas. */
  globe: RefObject<GlobeMethods | undefined>;
  /** True once the globe has reported ready. */
  ready: boolean;
  disasters: Disaster[];
  selectedId: string | null;
  show: boolean;
  /** Disasters left off the map (minor ones), kept built so they can come back at once. */
  hidden: ReadonlySet<string>;
  /** Width covered by a side panel on the right, px, so place labels flip before it. */
  rightInset: number;
  onSelect: (id: string) => void;
  /** Called before the layer moves the camera itself (a cluster zoom), so the globe stops turning. */
  onCameraMove?: () => void;
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** Live prefers-reduced-motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

// Accessors that never change live at module level: the globe re-processes
// a whole layer whenever an accessor's identity changes.

/** The globe keeps the object until its data leaves; nothing changes in place. */
const keepObject = () => {};
/** Areas and tracks use the page's own tooltip, not the globe's. */
const noLabel = () => "";
const pathStroke = (d: object) => ((d as PathItem).kind === "past" ? 1.8 : 1.5);
const pathDashLength = (d: object) => ((d as PathItem).kind === "forecast" ? 0.14 : 1);
const pathDashGap = (d: object) => ((d as PathItem).kind === "forecast" ? 0.1 : 0);
const htmlAltitude = (d: object) => ((d as MarkerItem | PlaceItem).kind === "marker" ? MARKER_ALTITUDE : PLACE_ALTITUDE);

/** Roughly how many outline points of area are built per frame while areas load. */
const CHUNK_VERTICES = 4000;
/** Longest wait for background shader compilation before building anyway, ms. */
const COMPILE_WAIT_MS = 2500;
/** How often markers are spread apart and place labels flipped, ms. */
const LAYOUT_MS = 150;
/** Steps in a ring's fade, so its colour strings are made once rather than every frame. */
const RING_FADE_STEPS = 20;

/** Resolves once the browser has painted the current frame. */
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Index just past the next batch of areas to build, starting at `from`. */
function chunkEnd(areas: AreaItem[], from: number): number {
  let i = from;
  let vertices = 0;
  do {
    for (const polygon of areas[i].fill) for (const ring of polygon) vertices += ring.length;
    i++;
  } while (i < areas.length && vertices < CHUNK_VERTICES);
  return i;
}

/** Fading colour strings for a ring, cached by colour and strength. */
const ringFades = new Map<string, string[]>();
function ringFade(color: string, k: number): string[] {
  const key = `${color}:${k}`;
  let steps = ringFades.get(key);
  if (!steps) {
    steps = Array.from({ length: RING_FADE_STEPS + 1 }, (_, i) => rgba(color, (1 - i / RING_FADE_STEPS) * 0.85 * k));
    ringFades.set(key, steps);
  }
  return steps;
}

/**
 * Screen-space tidying, a few times a second: merges markers that overlap
 * into the most important one, which then shows how many it stands for,
 * and flips place labels that would run past the visible edge. Positions
 * come from the camera, so nothing is measured.
 */
function layoutHtml(
  g: GlobeMethods,
  els: Map<MarkerItem | PlaceItem, HTMLElement>,
  selectedId: string | null,
  rightInset: number,
): void {
  const canvas = g.renderer().domElement;
  const bounds = { left: 0, right: canvas.clientWidth - rightInset };
  const markers: ScreenMarker[] = [];
  const visibleMarkers: [MarkerItem, HTMLElement][] = [];
  for (const [item, el] of els) {
    if (item.kind === "marker" && el.classList.contains("gv-hidden")) {
      // Past the horizon: neither a head nor merged.
      setMarkerCluster(el, 0);
      setMarkerMerged(el, false);
      continue;
    }
    if (el.classList.contains("gv-hidden")) continue;
    const alt = item.kind === "marker" ? MARKER_ALTITUDE : PLACE_ALTITUDE;
    const { x, y } = g.getScreenCoords(item.lat, item.lng, alt);
    if (item.kind === "place") {
      const width = placeLabelWidth(el);
      const { side, room } = placeLabelFit(item.side, x, width, bounds, item.nearMarker ? 22 : 13);
      setPlaceSide(el, side, room, width);
    } else {
      const rank = item.disasterId === selectedId ? 10 : item.severity;
      // A country-level marker's dashed ring reaches 5 px past its chip.
      const size = item.size + (item.precision === "country" ? 10 : 0);
      markers.push({ id: item.disasterId, x, y, size, rank });
      visibleMarkers.push([item, el]);
    }
  }
  const { heads, merged } = clusterMarkers(markers);
  const byId = new Map(visibleMarkers.map(([item]) => [item.disasterId, item]));
  for (const [item, el] of visibleMarkers) {
    setMarkerMerged(el, merged.has(item.disasterId));
    const members = heads.get(item.disasterId);
    // The selected marker is never a cluster: it opens its own panel.
    if (!members || item.disasterId === selectedId) {
      setMarkerCluster(el, 0);
      continue;
    }
    const all = [item, ...members.map((id) => byId.get(id)!)];
    const lat = all.reduce((s, m) => s + m.lat, 0) / all.length;
    const lng = all.reduce((s, m) => s + m.lng, 0) / all.length;
    setMarkerCluster(el, members.length, Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4);
  }
}

export function useDisasterLayers({ globe, ready, disasters, selectedId, show, hidden, rightInset, onSelect, onCameraMove }: Options) {
  const reduced = useReducedMotion();
  const [effects] = useState(() => new AreaEffects());
  useEffect(() => () => effects.dispose(), [effects]);

  // Hover comes from two places: areas and tracks (raycast by the globe) and
  // the DOM markers. A marker wins when both apply. Keyboard focus on a
  // marker highlights like a hover, but shows no pointer tooltip.
  const [areaHover, setAreaHover] = useState<string | null>(null);
  const [markerHover, setMarkerHover] = useState<string | null>(null);
  const [markerFocus, setMarkerFocus] = useState<string | null>(null);
  const pointerId = show ? (markerHover ?? areaHover) : null;
  const hoveredId = show ? (pointerId ?? markerFocus) : null;

  // Long-lived objects (meshes, DOM markers, the frame loop) read the latest values from here.
  const live = useRef({ selectedId, hoveredId, onSelect, rightInset, onCameraMove });
  useEffect(() => {
    live.current = { selectedId, hoveredId, onSelect, rightInset, onCameraMove };
  });

  const areas = useMemo(() => buildAreaItems(disasters), [disasters]);
  const allRings = useMemo(() => buildRingItems(disasters), [disasters]);
  const rings = useMemo(() => activeRings(allRings, [selectedId, hoveredId]), [allRings, selectedId, hoveredId]);
  // Hidden disasters are filtered out of the cheap layers; the built items
  // keep their identity, so the globe keeps the rest of the elements.
  const allPaths = useMemo(() => buildPathItems(disasters), [disasters]);
  const paths = useMemo(() => allPaths.filter((p) => !hidden.has(p.disasterId)), [allPaths, hidden]);
  const allMarkers = useMemo(() => buildMarkerItems(disasters), [disasters]);
  const markers = useMemo(() => allMarkers.filter((m) => !hidden.has(m.disasterId)), [allMarkers, hidden]);
  const selected = useMemo(() => disasters.find((d) => d.id === selectedId) ?? null, [disasters, selectedId]);
  const places = useMemo(() => buildPlaceItems(selected), [selected]);
  const html = useMemo<(MarkerItem | PlaceItem)[]>(() => (show ? [...markers, ...places] : []), [show, markers, places]);

  // Areas are built the first time the layer is shown, then kept: the
  // switch only hides them.
  const [everShown, setEverShown] = useState(show);
  if (show && !everShown) setEverShown(true);
  const [feed, setFeed] = useState<{ list: AreaItem[]; count: number }>({ list: [], count: 0 });
  useEffect(() => {
    if (!ready || !everShown || !areas.length) return;
    let cancelled = false;
    (async () => {
      await afterPaint(); // let the markers show first
      const g = globe.current;
      if (cancelled) return;
      if (g) {
        const compiled = effects.precompile(g.renderer(), g.camera(), g.scene(), areas).catch(() => undefined);
        await Promise.race([compiled, wait(COMPILE_WAIT_MS)]);
      }
      let count = 0;
      while (!cancelled && count < areas.length) {
        count = chunkEnd(areas, count);
        setFeed({ list: areas, count });
        await afterPaint();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, everShown, areas, effects, globe]);
  const areaData = useMemo(() => (feed.list === areas ? areas.slice(0, feed.count) : []), [feed, areas]);
  useEffect(() => effects.prune(areaData), [effects, areaData]);
  useEffect(() => effects.setShown(show), [effects, show]);
  useEffect(() => effects.setHidden(hidden), [effects, hidden]);

  // A marker removed under the pointer never sends pointerleave, and hidden
  // layers cannot stay hovered: forget hovers when either changes.
  const [hoverScope, setHoverScope] = useState({ show, disasters, hidden });
  if (hoverScope.show !== show || hoverScope.disasters !== disasters || hoverScope.hidden !== hidden) {
    setHoverScope({ show, disasters, hidden });
    setAreaHover(null);
    setMarkerHover(null);
    setMarkerFocus(null);
  }

  // The globe's HTML elements by item, to restyle markers when the
  // selection changes and to lay them out on screen.
  const htmlEls = useRef(new Map<MarkerItem | PlaceItem, HTMLElement>());
  useEffect(() => {
    const keep = new Set(html);
    for (const item of htmlEls.current.keys()) if (!keep.has(item)) htmlEls.current.delete(item);
    for (const [item, el] of htmlEls.current) if (item.kind === "marker") setMarkerState(el, selectedId);
  }, [selectedId, html]);

  // One frame loop for every effect while anything is shown: advances the
  // shaders (still under reduced motion, but highlights still ease), hides
  // areas past the horizon and tidies the markers. Pauses with the tab.
  const animate = show && (areaData.length > 0 || html.length > 0);
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let last = performance.now();
    let lastLayout = -Infinity;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const g = globe.current;
      const { selectedId: sel, hoveredId: hov, rightInset: inset } = live.current;
      effects.tick(dt, (id) => highlightTarget(id, sel, hov), reduced, g?.camera().position);
      if (g && now - lastLayout >= LAYOUT_MS) {
        lastLayout = now;
        layoutHtml(g, htmlEls.current, sel, inset);
      }
      raf = document.hidden ? 0 : requestAnimationFrame(loop);
    };
    const onVisible = () => {
      if (document.hidden || raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [animate, effects, reduced, globe]);

  // The globe passes its radius (100) along with each item.
  const createArea = useCallback((d: object, radius?: number) => effects.create(d as AreaItem, radius ?? 100), [effects]);
  const htmlElement = useCallback(
    (d: object) => {
      const item = d as MarkerItem | PlaceItem;
      const el =
        item.kind === "place"
          ? createPlaceElement(item)
          : createMarkerElement(item, {
              select: (id) => live.current.onSelect(id),
              // Closer to a cluster until its markers come apart; when already
              // as close as the camera goes, open the head.
              zoom: (id, lat, lng) => {
                const g = globe.current;
                if (!g) return;
                const { altitude } = g.pointOfView();
                if (altitude <= CLUSTER_MIN_ALTITUDE * 1.05) {
                  live.current.onSelect(id);
                  return;
                }
                live.current.onCameraMove?.();
                g.pointOfView({ lat, lng, altitude: Math.max(CLUSTER_MIN_ALTITUDE, altitude * CLUSTER_ZOOM) }, 900);
              },
              hover: setMarkerHover,
              focus: setMarkerFocus,
              // Re-sent to the canvas, where the globe's controls listen.
              wheel: (e) => globe.current?.renderer().domElement.dispatchEvent(new WheelEvent("wheel", e)),
            });
      if (item.kind === "marker") setMarkerState(el, live.current.selectedId);
      htmlEls.current.set(item, el);
      return el;
    },
    [globe],
  );

  const selectFrom = useCallback((d: object | null) => {
    const id = (d as { disasterId?: string } | null)?.disasterId;
    if (id) live.current.onSelect(id);
  }, []);
  const hoverFrom = useCallback((d: object | null) => {
    setAreaHover((d as { disasterId?: string } | null)?.disasterId ?? null);
  }, []);

  // Rings read their colour when each new ring starts, so this needs no data rebuild.
  const ringColor = useCallback((d: object) => {
    const r = d as RingItem;
    const sel = live.current.selectedId;
    const steps = ringFade(r.color, sel && sel !== r.disasterId ? 0.35 : 1);
    return (t: number) => steps[Math.round(Math.min(1, Math.max(0, t)) * RING_FADE_STEPS)];
  }, []);

  const pathColor = useCallback(
    (d: object) => {
      const p = d as PathItem;
      const k = selectedId && selectedId !== p.disasterId ? 0.35 : 1;
      return rgba(p.color, (p.kind === "past" ? 0.8 : 0.7) * k);
    },
    [selectedId],
  );
  const pathDashAnimateTime = useCallback((d: object) => ((d as PathItem).kind === "forecast" && !reduced ? 4000 : 0), [reduced]);

  const props = useMemo<Partial<GlobeGLProps>>(
    () => ({
      // Animated areas.
      customLayerData: areaData,
      customThreeObject: createArea as (d: object) => Object3D,
      customThreeObjectUpdate: keepObject,
      customLayerLabel: noLabel,
      onCustomLayerHover: hoverFrom,
      onCustomLayerClick: selectFrom,

      // Expanding rings from epicentres, vents and tsunami sources.
      ringsData: show && !reduced ? rings : [],
      ringAltitude: RING_ALTITUDE,
      ringColor,
      ringMaxRadius: "maxRadius",
      ringPropagationSpeed: "speed",
      ringRepeatPeriod: "period",

      // Storm tracks: past solid, forecast dashed and moving.
      pathsData: show ? paths : [],
      pathPoints: "points",
      pathPointLat: "lat",
      pathPointLng: "lng",
      pathPointAlt: PATH_ALTITUDE,
      pathColor,
      pathStroke,
      pathDashLength,
      pathDashGap,
      pathDashAnimateTime,
      pathTransitionDuration: 0,
      pathLabel: noLabel,
      onPathHover: hoverFrom,
      onPathClick: selectFrom,

      // Markers and the selected disaster's places.
      htmlElementsData: html,
      htmlLat: "lat",
      htmlLng: "lng",
      htmlAltitude,
      htmlElement,
      htmlElementVisibilityModifier: setElementVisible,
      htmlTransitionDuration: 0,
    }),
    [areaData, createArea, hoverFrom, selectFrom, show, reduced, rings, ringColor, paths, pathColor, pathDashAnimateTime, html, htmlElement],
  );

  return {
    props,
    /** The disaster under the pointer, if any, for the tooltip. */
    hovered: useMemo(() => (pointerId ? (disasters.find((d) => d.id === pointerId) ?? null) : null), [disasters, pointerId]),
    /** True while a disaster is hovered or a marker has keyboard focus: the globe holds still. */
    engaged: hoveredId !== null,
  };
}

/**
 * Pointer filter for the globe: areas too big to be a sensible click target
 * (see CLICKABLE_AREA_MAX_KM2) let the pointer through to the countries.
 */
export function disasterPointerFilter(obj: Object3D, data?: object): boolean {
  if ((obj as Object3D & { __globeObjType?: string }).__globeObjType !== "custom") return true;
  return !!(data as AreaItem | undefined)?.clickable;
}
