"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GlobeGL, { type GlobeMethods } from "react-globe.gl";
import { AmbientLight, DirectionalLight, MeshLambertMaterial } from "three";
import { loadCountries, type CountryFeature } from "@/lib/geo";

// Colours are read from the CSS tokens in globals.css so the globe always
// matches the rest of the page.
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

export default function Globe() {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Last known pointer position, so the tooltip can appear in the right
  // place the moment a country is hovered.
  const pointerRef = useRef({ x: 0, y: 0 });
  // Set once the user drags, scrolls or taps; the globe then stays still.
  const touchedRef = useRef(false);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [countries, setCountries] = useState<CountryFeature[]>([]);
  const [hovered, setHovered] = useState<CountryFeature | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const colors = useMemo(
    () => ({
      ocean: token("--ocean", "#dce4ea"),
      land: token("--land", "#efe6d2"),
      landHover: token("--land-hover", "#e0d3b4"),
      border: token("--border", "#ffffff"),
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

  useEffect(() => {
    loadCountries().then(setCountries).catch(console.error);
  }, []);

  // Rotate slowly until the user interacts. Pause while a country is hovered
  // so the tooltip does not flicker between neighbours.
  const setRotation = useCallback(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !touchedRef.current && !hovered;
  }, [hovered]);

  useEffect(setRotation, [setRotation]);

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

    // Start a little further out on narrow screens so the globe fits.
    const aspect = size.width / Math.max(size.height, 1);
    const altitude = aspect < 1 ? 2.1 / aspect : 2.1;
    globe.pointOfView({ lat: 18, lng: 30, altitude }, 0);
  }, [size.width, size.height, setRotation]);

  const capColor = useCallback(
    (d: object) => (d === hovered ? colors.landHover : colors.land),
    [hovered, colors],
  );

  const handleHover = useCallback((d: object | null) => {
    setPointer(pointerRef.current);
    setHovered((d as CountryFeature | null) ?? null);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="h-full w-full"
      style={{ cursor: hovered ? "pointer" : "grab" }}
      onPointerMove={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY };
        if (hovered) setPointer(pointerRef.current);
      }}
    >
      {size.width > 0 && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={oceanMaterial}
          showAtmosphere
          atmosphereColor="#c9d3dc"
          atmosphereAltitude={0.12}
          animateIn={false}
          rendererConfig={{ antialias: true, alpha: true }}
          polygonsData={countries}
          polygonAltitude={0.005}
          polygonCapColor={capColor}
          polygonSideColor={() => "rgba(0,0,0,0)"}
          polygonStrokeColor={() => colors.border}
          polygonsTransitionDuration={0}
          onPolygonHover={handleHover}
          onGlobeReady={handleReady}
        />
      )}

      {hovered && (
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
