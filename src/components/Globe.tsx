"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import GlobeGL, { type GlobeMethods } from "react-globe.gl";
import { AmbientLight, DirectionalLight, MeshLambertMaterial } from "three";
import { arcScaleFor, countryFocus, type CountryFeature } from "@/lib/geo";
import type { Disaster } from "@/lib/data";
import { disasterFocus } from "@/lib/disasterLayers";
import { tooltipDetail } from "./disasters/markers";
import { disasterPointerFilter, useDisasterLayers, useReducedMotion } from "./disasters/useDisasterLayers";
import { useDetailedCountries } from "./useDetailedCountries";

/** A line between two countries reading the same story. */
export interface GlobeArc {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  /** 0..1; stronger arcs are brighter and thicker. */
  strength: number;
}

export interface GlobeProps {
  countries: CountryFeature[];
  /** Coverage per country code: local editions in deeper sand, world coverage a shade paler. */
  coverage: Map<string, "local" | "world">;
  /** Countries to tint towards the accent, 0..1 by how strongly. */
  tints: Map<string, number>;
  arcs: GlobeArc[];
  selected: CountryFeature | null;
  onSelect: (code: string) => void;
  /** Screen space covered by panels, so the globe can shift away from them. */
  inset: { right: number; bottom: number };
  /** Disasters happening now, drawn as animated areas with markers. */
  disasters: Disaster[];
  /** The disaster whose donation pages are open; the camera flies to it. */
  selectedDisasterId: string | null;
  /** False hides every disaster layer. */
  showDisasters: boolean;
  /** Called when a disaster's marker, area or track is clicked. */
  onSelectDisaster: (id: string) => void;
}

/** How long the camera takes to travel to a clicked country. */
const FLY_MS = 1200;

/** Country sides are invisible; a constant so the polygon layer is not re-processed on every render. */
const noSide = () => "rgba(0,0,0,0)";

/**
 * Stops auto-rotation and any spin the controls are still easing out of, so
 * a fly-to lands where it aims instead of drifting past it. Updating once
 * with damping off applies the leftover spin and clears it.
 */
function stopSpin(globe: GlobeMethods) {
  const controls = globe.controls();
  controls.autoRotate = false;
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = damping;
}

/** Blends two hex colours; t = 0 gives a, t = 1 gives b. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function hexToRgba(hex: string, alpha: number): string {
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255}, ${(p >> 8) & 255}, ${p & 255}, ${alpha})`;
}

// Colours are read from the CSS tokens in globals.css so the globe always
// matches the rest of the page.
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

const codeOf = (d: object | null | undefined) => (d as CountryFeature | null | undefined)?.properties.code;

export default function Globe({
  countries,
  coverage,
  tints,
  arcs,
  selected,
  onSelect,
  inset,
  disasters,
  selectedDisasterId,
  showDisasters,
  onSelectDisaster,
}: GlobeProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Last known mouse or pen position, so the tooltip can appear in the right
  // place the moment something is hovered. Null until a pointer has moved,
  // and for touch, where a hover tooltip would just linger after a tap.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useCallback(() => pointerRef.current, []);
  // Set once the user drags, scrolls, taps or selects; the globe then stays still.
  const touchedRef = useRef(false);
  const reduced = useReducedMotion();

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [hovered, setHovered] = useState<CountryFeature | null>(null);

  // Sharper country shapes near a low camera.
  const detailed = useDetailedCountries(countries);

  // Disaster areas, rings, tracks and markers, and the one under the pointer.
  const layers = useDisasterLayers({
    globe: globeRef,
    ready,
    disasters,
    selectedId: selectedDisasterId,
    show: showDisasters,
    rightInset: inset.right,
    onSelect: onSelectDisaster,
  });
  const hoveredDisaster = layers.hovered;
  // A disaster under the pointer takes the tooltip and the hover from the country beneath it.
  const hoveredCountry = hoveredDisaster ? null : hovered;
  const selectedCode = selected?.properties.code ?? null;
  const hoveredCode = hoveredCountry?.properties.code ?? null;

  const colors = useMemo(
    () => ({
      ocean: token("--ocean", "#dce4ea"),
      land: token("--land", "#f0ebdf"),
      landData: token("--land-data", "#e7dab6"),
      landWorld: token("--land-world", "#ebe3cf"),
      landHover: token("--land-hover", "#dccca3"),
      landSelected: token("--land-selected", "#d2c08f"),
      border: token("--border", "#ffffff"),
      accent: token("--accent", "#1f6f78"),
    }),
    [],
  );

  // A matte, evenly lit sphere for the ocean. No texture, no highlights.
  const oceanMaterial = useMemo(
    () => new MeshLambertMaterial({ color: colors.ocean }),
    [colors.ocean],
  );

  // Fill the parent and re-render when it changes size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rotate slowly until the user interacts, and never under reduced motion.
  // Pause while a country or disaster is hovered (or a marker has keyboard
  // focus) so the tooltip does not flicker and the marker stays in view.
  const setRotation = useCallback(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !touchedRef.current && !reduced && !hovered && !layers.engaged;
  }, [hovered, layers.engaged, reduced]);

  useEffect(setRotation, [setRotation]);

  // Narrow screens need a higher camera for the same country to fit.
  const altitudeScale = useCallback(() => {
    const aspect = size.width / Math.max(size.height, 1);
    return aspect < 1 ? 0.8 / aspect : 1;
  }, [size.width, size.height]);

  const handleReady = useCallback(() => {
    const globe = globeRef.current;
    if (!globe) return;

    // Mostly ambient light with a faint key light, so the globe reads as a
    // sphere without a dark side or a bright hotspot.
    const key = new DirectionalLight(0xffffff, 0.45);
    key.position.set(-1, 0.8, 1);
    globe.lights([new AmbientLight(0xffffff, 2.4), key]);

    const controls = globe.controls();
    controls.autoRotateSpeed = 0.4;
    controls.enablePan = false;
    // Close enough to read a city-sized flood or fire.
    controls.minDistance = 108;
    controls.maxDistance = 520;
    controls.addEventListener("start", () => {
      touchedRef.current = true;
      controls.autoRotate = false;
    });
    setRotation();

    globe.pointOfView({ lat: 18, lng: 30, altitude: 2.1 * altitudeScale() }, 0);
    // The fly-to effects below wait for this, so a shared link that arrived
    // before the globe was ready still moves the camera.
    setReady(true);
  }, [setRotation, altitudeScale]);

  // Fly to the selected country. Runs when the selection changes (or the
  // globe becomes ready), not when the user merely resizes, so it does not
  // fight their own dragging.
  useEffect(() => {
    const globe = globeRef.current;
    if (!ready || !globe || !selected) return;
    touchedRef.current = true;
    stopSpin(globe);
    detailed.prefetch();
    const focus = countryFocus(selected);
    globe.pointOfView(
      { lat: focus.lat, lng: focus.lng, altitude: focus.altitude * altitudeScale() },
      FLY_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, ready]);

  // Fly to the selected disaster, framing its areas and places. Waits for the
  // disaster list and the globe if the selection arrives first (a shared link).
  const selectedDisaster = useMemo(
    () => disasters.find((d) => d.id === selectedDisasterId) ?? null,
    [disasters, selectedDisasterId],
  );
  useEffect(() => {
    const globe = globeRef.current;
    if (!ready || !globe || !selectedDisaster) return;
    touchedRef.current = true;
    stopSpin(globe);
    detailed.prefetch();
    const focus = disasterFocus(selectedDisaster);
    globe.pointOfView(
      { lat: focus.lat, lng: focus.lng, altitude: focus.altitude * altitudeScale() },
      FLY_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDisaster?.id, ready]);

  // Country styling compares codes, not objects: near the camera the drawn
  // shape is a more detailed copy of the selected country.
  const capColor = useCallback(
    (d: object) => {
      const code = codeOf(d)!;
      if (code === selectedCode) return colors.landSelected;
      if (code === hoveredCode) return colors.landHover;
      const kind = coverage.get(code);
      const base = kind === "local" ? colors.landData : kind === "world" ? colors.landWorld : colors.land;
      const tint = tints.get(code);
      return tint === undefined ? base : mixHex(base, colors.accent, 0.14 + 0.36 * tint);
    },
    [hoveredCode, selectedCode, coverage, tints, colors],
  );

  const arcColor = useCallback(
    (d: object) => hexToRgba(colors.accent, 0.25 + 0.45 * (d as GlobeArc).strength),
    [colors.accent],
  );
  // Arc width is in globe units, so it would swell into thick bars as the
  // camera zooms in. It shrinks with altitude, in steps so the arcs are not
  // rebuilt on every frame of a zoom.
  const [arcScale, setArcScale] = useState(1);
  const arcStroke = useCallback((d: object) => (0.18 + 0.3 * (d as GlobeArc).strength) * arcScale, [arcScale]);
  const onView = detailed.onView;
  const handleZoom = useCallback(
    (view: { lat: number; lng: number; altitude: number }) => {
      onView(view);
      setArcScale(arcScaleFor(view.altitude));
    },
    [onView],
  );
  const strokeColor = useCallback(
    (d: object) => (codeOf(d) === selectedCode ? colors.accent : colors.border),
    [selectedCode, colors],
  );
  // Lift the selected country a touch so its outline draws over neighbours.
  const altitude = useCallback(
    (d: object) => (codeOf(d) === selectedCode ? 0.012 : 0.005),
    [selectedCode],
  );

  const handleHover = useCallback((d: object | null) => {
    setHovered((d as CountryFeature | null) ?? null);
  }, []);

  const handleClick = useCallback(
    (d: object) => onSelect(codeOf(d)!),
    [onSelect],
  );

  const globeOffset = useMemo<[number, number]>(() => [-inset.right / 2, -inset.bottom / 2], [inset.right, inset.bottom]);

  const tip: { key: string; body: ReactNode } | null = hoveredDisaster
    ? {
        key: `d:${hoveredDisaster.id}`,
        body: (
          <span className="block max-w-64">
            <span className="block font-medium leading-snug">{hoveredDisaster.title}</span>
            <span className="block text-xs text-muted">{tooltipDetail(hoveredDisaster.type, hoveredDisaster.severity)}</span>
          </span>
        ),
      }
    : hoveredCountry && hoveredCode !== selectedCode
      ? { key: `c:${hoveredCode}`, body: hoveredCountry.properties.name }
      : null;

  return (
    <div
      ref={wrapRef}
      // isolate: the marker renderer numbers each marker's z-index by
      // distance, up to the marker count, so without a stacking context of
      // their own the markers would rise above the panels and the sheet.
      className="isolate h-full w-full"
      style={{ cursor: hovered || hoveredDisaster ? "pointer" : "grab" }}
      onPointerMove={(e) => {
        pointerRef.current = e.pointerType === "touch" ? null : { x: e.clientX, y: e.clientY };
      }}
      onPointerLeave={() => {
        pointerRef.current = null;
      }}
      // A keyboard user focusing a marker has taken over: stop turning for
      // good, including any spin the controls are still easing out of.
      onFocus={() => {
        touchedRef.current = true;
        if (globeRef.current) stopSpin(globeRef.current);
      }}
    >
      {size.width > 0 && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          globeOffset={globeOffset}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={oceanMaterial}
          showAtmosphere
          atmosphereColor="#c9d3dc"
          atmosphereAltitude={0.12}
          animateIn={false}
          rendererConfig={{ antialias: true, alpha: true }}
          polygonsData={detailed.features}
          polygonAltitude={altitude}
          polygonCapColor={capColor}
          polygonSideColor={noSide}
          polygonStrokeColor={strokeColor}
          polygonsTransitionDuration={0}
          onPolygonHover={handleHover}
          onPolygonClick={handleClick}
          arcsData={arcs}
          arcStartLat="startLat"
          arcStartLng="startLng"
          arcEndLat="endLat"
          arcEndLng="endLng"
          arcColor={arcColor}
          arcStroke={arcStroke}
          arcAltitudeAutoScale={0.35}
          arcDashLength={0.5}
          arcDashGap={0.3}
          arcDashAnimateTime={reduced ? 0 : 6000}
          arcsTransitionDuration={reduced ? 0 : 600}
          {...layers.props}
          pointerEventsFilter={disasterPointerFilter}
          onZoom={handleZoom}
          onGlobeReady={handleReady}
        />
      )}

      {tip && (
        <HoverTip key={tip.key} wrap={wrapRef} initial={lastPointer}>
          {tip.body}
        </HoverTip>
      )}
    </div>
  );
}

/**
 * The tooltip for whatever is hovered, following the pointer. It keeps the
 * pointer position itself, so the globe does not re-render on every move.
 */
function HoverTip({
  wrap,
  initial,
  children,
}: {
  wrap: RefObject<HTMLDivElement | null>;
  /** Where the pointer was when the hover began. */
  initial: () => { x: number; y: number } | null;
  children: ReactNode;
}) {
  const [pos, setPos] = useState(initial);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const move = (e: PointerEvent) => setPos(e.pointerType === "touch" ? null : { x: e.clientX, y: e.clientY });
    // Over a card or the header the globe gets no more moves, so drop the
    // tooltip rather than leave it stuck.
    const leave = () => setPos(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [wrap]);
  if (!pos) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-10 rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink shadow-sm"
      style={{ left: pos.x + 14, top: pos.y + 14 }}
    >
      {children}
    </div>
  );
}
