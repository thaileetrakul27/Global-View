"use client";

// Sharper coastlines and borders close up. The globe starts with Natural
// Earth's 110m shapes, light and fine from afar. When the camera comes low
// it fetches the 50m shapes once, and swaps them in for the countries near
// the view once the camera rests, so a flood on a coast lands on the right
// side of it. Swapped countries keep their detail; the rest stay light.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countriesNear, detailReach, featureBoxes, type CountryCollection, type CountryFeature } from "@/lib/geo";

const DETAIL_URL = "/geo/countries-50m.geojson";
/** Camera altitude (globe radii) below which nearby countries get detailed shapes. */
export const DETAIL_ALTITUDE = 0.75;
/** Below this altitude the detailed file starts loading, ahead of need. */
const PREFETCH_ALTITUDE = 1.4;
/** How long the camera must rest before shapes are swapped, ms. */
const SETTLE_MS = 300;

export interface View {
  lat: number;
  lng: number;
  altitude: number;
}

export function useDetailedCountries(countries: CountryFeature[]) {
  const [detail, setDetail] = useState<Map<string, CountryFeature> | null>(null);
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const loading = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<View | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const boxes = useMemo(() => new Map(countries.map((c) => [c.properties.code, featureBoxes(c)])), [countries]);

  /** Fetches the detailed shapes once. A failure keeps the light shapes for good. */
  const prefetch = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    fetch(DETAIL_URL)
      .then((res) => (res.ok ? (res.json() as Promise<CountryCollection>) : null))
      .then((data) => {
        if (data) setDetail(new Map(data.features.map((f) => [f.properties.code, f])));
      })
      .catch(() => {});
  }, []);

  /** Marks the countries around a resting low camera for detail. */
  const settle = useCallback(() => {
    const view = latest.current;
    if (!view || view.altitude >= DETAIL_ALTITUDE) return;
    const codes = countriesNear(boxes, view.lat, view.lng, detailReach(view.altitude));
    setNear((prev) => (codes.every((c) => prev.has(c)) ? prev : new Set([...prev, ...codes])));
  }, [boxes]);

  /** Called with the camera's position whenever it moves. */
  const onView = useCallback(
    (view: View) => {
      latest.current = view;
      if (view.altitude < PREFETCH_ALTITUDE) prefetch();
      clearTimeout(timer.current);
      timer.current = setTimeout(settle, SETTLE_MS);
    },
    [prefetch, settle],
  );

  const features = useMemo(
    () => (detail && near.size ? countries.map((c) => (near.has(c.properties.code) && detail.get(c.properties.code)) || c) : countries),
    [countries, detail, near],
  );
  return { features, onView, prefetch };
}
