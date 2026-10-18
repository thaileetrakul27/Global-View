"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GlobeGL, { type GlobeMethods } from "react-globe.gl";
import { AmbientLight, DirectionalLight, MeshLambertMaterial } from "three";
import { countryFocus, type CountryFeature } from "@/lib/geo";

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
  /** Codes of countries that have stories; they are drawn in a deeper sand. */
  withData: Set<string>;
  /** Countries to tint towards the accent, 0..1 by how strongly. */
  tints: Map<string, number>;
  arcs: GlobeArc[];
  selected: CountryFeature | null;
  onSelect: (code: string) => void;
  /** Screen space covered by panels, so the globe can shift away from them. */
  inset: { right: number; bottom: number };
}

/** How long the camera takes to travel to a clicked country. */
const FLY_MS = 1200;

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

export default function Globe({ countries, withData, tints, arcs, selected, onSelect, inset }: GlobeProps) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Last known mouse or pen position, so the tooltip can appear in the right
  // place the moment a country is hovered. Null until a pointer has moved,
  // and for touch, where a hover tooltip would just linger after a tap.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  // Set once the user drags, scrolls, taps or selects; the globe then stays still.
  const touchedRef = useRef(false);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<CountryFeature | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const colors = useMemo(
    () => ({
      ocean: token("--ocean", "#dce4ea"),
      land: token("--land", "#f0ebdf"),
      landData: token("--land-data", "#e7dab6"),
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

  // Rotate slowly until the user interacts. Pause while a country is hovered
  // so the tooltip does not flicker between neighbours.
  const setRotation = useCallback(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !touchedRef.current && !hovered;
  }, [hovered]);

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
    controls.minDistance = 160;
    controls.maxDistance = 520;
    controls.addEventListener("start", () => {
      touchedRef.current = true;
      controls.autoRotate = false;
    });
    setRotation();

    globe.pointOfView({ lat: 18, lng: 30, altitude: 2.1 * altitudeScale() }, 0);
  }, [setRotation, altitudeScale]);

  // Fly to the selected country. Runs when the selection changes, not when the
  // user merely resizes, so it does not fight their own dragging.
  const selectedCode = selected?.properties.code;
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !selected) return;
    touchedRef.current = true;
    globe.controls().autoRotate = false;
    const focus = countryFocus(selected);
    globe.pointOfView(
      { lat: focus.lat, lng: focus.lng, altitude: focus.altitude * altitudeScale() },
      FLY_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode]);

  const capColor = useCallback(
    (d: object) => {
      if (d === selected) return colors.landSelected;
      if (d === hovered) return colors.landHover;
      const code = (d as CountryFeature).properties.code;
      const base = withData.has(code) ? colors.landData : colors.land;
      const tint = tints.get(code);
      return tint === undefined ? base : mixHex(base, colors.accent, 0.14 + 0.36 * tint);
    },
    [hovered, selected, withData, tints, colors],
  );

  const arcColor = useCallback(
    (d: object) => hexToRgba(colors.accent, 0.25 + 0.45 * (d as GlobeArc).strength),
    [colors.accent],
  );
  const arcStroke = useCallback((d: object) => 0.18 + 0.3 * (d as GlobeArc).strength, []);
  const strokeColor = useCallback(
    (d: object) => (d === selected ? colors.accent : colors.border),
    [selected, colors],
  );
  // Lift the selected country a touch so its outline draws over neighbours.
  const altitude = useCallback(
    (d: object) => (d === selected ? 0.012 : 0.005),
    [selected],
  );

  const handleHover = useCallback((d: object | null) => {
    setPointer(pointerRef.current);
    setHovered((d as CountryFeature | null) ?? null);
  }, []);

  const handleClick = useCallback(
    (d: object) => onSelect((d as CountryFeature).properties.code),
    [onSelect],
  );

  return (
    <div
      ref={wrapRef}
      className="h-full w-full"
      style={{ cursor: hovered ? "pointer" : "grab" }}
      onPointerMove={(e) => {
        if (e.pointerType === "touch") return;
        pointerRef.current = { x: e.clientX, y: e.clientY };
        if (hovered) setPointer(pointerRef.current);
      }}
    >
      {size.width > 0 && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          globeOffset={[-inset.right / 2, -inset.bottom / 2]}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={oceanMaterial}
          showAtmosphere
          atmosphereColor="#c9d3dc"
          atmosphereAltitude={0.12}
          animateIn={false}
          rendererConfig={{ antialias: true, alpha: true }}
          polygonsData={countries}
          polygonAltitude={altitude}
          polygonCapColor={capColor}
          polygonSideColor={() => "rgba(0,0,0,0)"}
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
          arcDashAnimateTime={6000}
          arcsTransitionDuration={600}
          onGlobeReady={handleReady}
        />
      )}

      {hovered && pointer && hovered !== selected && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-10 rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-ink shadow-sm"
          style={{ left: pointer.x + 14, top: pointer.y + 14 }}
        >
          {hovered.properties.name}
        </div>
      )}
    </div>
  );
}
