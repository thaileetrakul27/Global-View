"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { countryFocus, loadCountries, type CountryFeature } from "@/lib/geo";
import {
  loadAttention,
  loadCountry,
  loadIndex,
  loadShared,
  type AttentionFile,
  type CountryFile,
  type IndexFile,
  type SharedFile,
  type SharedStory,
} from "@/lib/data";
import { inbound, outbound, tintMap } from "@/lib/attention";
import { useViewport } from "@/lib/useViewport";
import GlobeView from "./GlobeView";
import type { GlobeArc } from "./Globe";
import CountrySearch from "./CountrySearch";
import CountryPanel, { type CountryState } from "./CountryPanel";
import type { AttentionMode } from "./AttentionChips";
import BottomSheet from "./BottomSheet";
import WorldStories from "./WorldStories";
import StoryPanel from "./StoryPanel";
import type { SharedRef } from "./ArticleList";

/** Desktop side panel width in px, capped so the globe keeps two thirds. */
export const PANEL_WIDTH = 440;
/** Fraction of the screen height the mobile sheet covers when peeking. */
export const SHEET_PEEK = 0.42;

// Top-level client state: the country list, the selected country, and the
// layout mode. The globe, search box and panel all read from here.
export default function App() {
  const [countries, setCountries] = useState<CountryFeature[]>([]);
  const [index, setIndex] = useState<IndexFile | null>(null);
  const [shared, setShared] = useState<SharedFile | null>(null);
  const [attention, setAttention] = useState<AttentionFile | null>(null);
  const [attentionMode, setAttentionMode] = useState<AttentionMode>("outbound");
  // When set, the panel lists only the selected country's stories about this code.
  const [filterAbout, setFilterAbout] = useState<string | null>(null);
  // A shared story opened from the landing card or an article badge. It
  // takes over the panel and only its arcs are drawn.
  const [focusStoryId, setFocusStoryId] = useState<string | null>(null);
  // Country to return to when the story panel closes.
  const [storyFrom, setStoryFrom] = useState<string | null>(null);
  // Country files already fetched, keyed by code. Null marks "no file".
  const [files, setFiles] = useState<Record<string, CountryFile | null | "error">>({});
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const vp = useViewport();

  useEffect(() => {
    loadCountries().then(setCountries).catch(console.error);
    loadIndex().then(setIndex).catch(console.error);
    loadShared().then(setShared).catch(console.error);
    loadAttention().then(setAttention).catch(console.error);
  }, []);

  // Fetch the selected country's stories once, then keep them. The index
  // says which countries have a file, so no request is made for the rest.
  useEffect(() => {
    if (!selectedCode || selectedCode in files) return;
    if (index && !(selectedCode in index.countries)) return; // nothing to fetch
    let cancelled = false;
    loadCountry(selectedCode)
      .then((data) => {
        if (!cancelled) setFiles((f) => ({ ...f, [selectedCode]: data }));
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setFiles((f) => ({ ...f, [selectedCode]: "error" }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCode, files, index]);

  // Codes of countries that have stories, for colouring the globe.
  const withData = useMemo(
    () => new Set(index ? Object.keys(index.countries) : []),
    [index],
  );

  // Lookups by country code: display name and a point to draw arcs from.
  const byCode = useMemo(() => new Map(countries.map((c) => [c.properties.code, c])), [countries]);
  const nameOf = useCallback((code: string) => byCode.get(code)?.properties.name ?? code, [byCode]);
  const centroids = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>();
    for (const c of countries) {
      const f = countryFocus(c);
      m.set(c.properties.code, { lat: f.lat, lng: f.lng });
    }
    return m;
  }, [countries]);

  // Arcs: a selected country's shared stories; otherwise the focused story,
  // or faintly the stories most countries share. Lines start from the
  // country a story is about, so the globe shows where attention points.
  const arcs = useMemo<GlobeArc[]>(() => {
    const stories = shared?.stories ?? [];
    let picked: { story: SharedStory; strength: number }[];
    if (selectedCode) {
      picked = stories.filter((s) => s.countries.includes(selectedCode)).map((story) => ({ story, strength: 1 }));
    } else if (focusStoryId) {
      picked = stories.filter((s) => s.id === focusStoryId).map((story) => ({ story, strength: 1 }));
    } else {
      picked = stories.slice(0, 8).map((story) => ({ story, strength: 0.45 }));
    }
    const out = new Map<string, GlobeArc>();
    for (const { story, strength } of picked) {
      const hub =
        selectedCode && story.countries.includes(selectedCode)
          ? selectedCode
          : story.subject && centroids.has(story.subject)
            ? story.subject
            : story.countries[0];
      const from = centroids.get(hub);
      if (!from) continue;
      for (const code of story.countries) {
        if (code === hub) continue;
        const to = centroids.get(code);
        if (!to) continue;
        const key = [hub, code].sort().join("-");
        const prev = out.get(key);
        if (!prev || prev.strength < strength) {
          out.set(key, { startLat: from.lat, startLng: from.lng, endLat: to.lat, endLng: to.lng, strength });
        }
      }
    }
    return [...out.values()];
  }, [shared, selectedCode, focusStoryId, centroids]);

  // Tints: who the selected country is reading about, or who reads about it.
  const mentions = useMemo(
    () => (selectedCode ? (attentionMode === "outbound" ? outbound(attention, selectedCode, 12) : inbound(attention, selectedCode, 12)) : []),
    [attention, selectedCode, attentionMode],
  );
  const tints = useMemo(() => tintMap(mentions), [mentions]);
  // Until the pipeline has translated anything, there is nothing to show.
  const hasAttention = !!attention && Object.keys(attention.mentions).length > 0;

  // Which shared story each article belongs to, by article link.
  const sharedRefs = useMemo(() => {
    const m = new Map<string, SharedRef>();
    for (const s of shared?.stories ?? []) for (const a of s.articles) m.set(a.url, { id: s.id, count: s.countries.length });
    return m;
  }, [shared]);
  const focusedStory = useMemo(
    () => (focusStoryId ? (shared?.stories.find((s) => s.id === focusStoryId) ?? null) : null),
    [shared, focusStoryId],
  );

  const countryState: CountryState = useMemo(() => {
    if (!selectedCode) return { status: "loading" };
    if (index && !(selectedCode in index.countries)) return { status: "none" };
    if (!(selectedCode in files)) return { status: "loading" };
    const f = files[selectedCode];
    if (f === "error") return { status: "error" };
    if (f === null) return { status: "none" };
    return { status: "ready", data: f };
  }, [selectedCode, files, index]);

  const selected = useMemo(
    () => countries.find((c) => c.properties.code === selectedCode) ?? null,
    [countries, selectedCode],
  );

  const select = useCallback((code: string | null, about?: string) => {
    setSelectedCode(code);
    setFilterAbout(about ?? null);
    setFocusStoryId(null);
    setStoryFrom(null);
  }, []);
  const close = useCallback(() => {
    setSelectedCode(null);
    setFilterAbout(null);
    setFocusStoryId(null);
    setStoryFrom(null);
  }, []);
  const openStory = useCallback(
    (id: string | null) => {
      if (!id) {
        setFocusStoryId(null);
        return;
      }
      setStoryFrom(selectedCode);
      setSelectedCode(null);
      setFilterAbout(null);
      setFocusStoryId(id);
    },
    [selectedCode],
  );
  const closeStory = useCallback(() => {
    setFocusStoryId(null);
    setSelectedCode(storyFrom);
    setStoryFrom(null);
  }, [storyFrom]);
  const changeMode = useCallback((m: AttentionMode) => {
    setAttentionMode(m);
    setFilterAbout(null);
  }, []);

  // Escape closes the story or the country, unless a control such as the
  // search list handles it first.
  useEffect(() => {
    if (!selectedCode && !focusStoryId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (focusStoryId) closeStory();
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCode, focusStoryId, close, closeStory]);

  // How much of the viewport the open panel covers, so the globe can shift
  // its centre into the remaining space.
  const panelWidth = Math.min(PANEL_WIDTH, vp.width * 0.38);
  const panelOpen = !!selected || !!focusedStory;
  const inset = panelOpen
    ? vp.isDesktop
      ? { right: panelWidth, bottom: 0 }
      : { right: 0, bottom: vp.height * SHEET_PEEK }
    : { right: 0, bottom: 0 };

  return (
    <main className="relative h-full w-full overflow-hidden">
      <GlobeView
        countries={countries}
        withData={withData}
        tints={tints}
        arcs={arcs}
        selected={selected}
        onSelect={select}
        inset={inset}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col gap-4 p-5 sm:p-7 md:flex-row md:items-start md:justify-between">
        <div className="pointer-events-auto">
          <h1 className="font-serif text-2xl leading-none tracking-tight text-ink sm:text-3xl">
            Global View
          </h1>
          <p className="mt-1.5 max-w-xs text-sm leading-snug text-muted">
            The stories each country is reading right now.
          </p>
        </div>
        <div className="pointer-events-auto w-full md:absolute md:left-1/2 md:w-80 md:-translate-x-1/2">
          <CountrySearch countries={countries} onSelect={select} />
        </div>
      </header>

      {!panelOpen && (
        <p className="pointer-events-none absolute inset-x-0 bottom-5 text-center text-xs text-muted sm:bottom-6">
          Drag to turn the globe, or click a country
        </p>
      )}

      {!selected && shared && vp.isDesktop && (
        <div className="pointer-events-none absolute bottom-6 left-5 z-20 sm:left-7">
          <WorldStories stories={shared.stories} focusId={focusStoryId} onFocus={openStory} nameOf={nameOf} />
        </div>
      )}

      {vp.isDesktop ? (
        <aside
          aria-label={focusedStory ? "Story" : "Country"}
          aria-hidden={!panelOpen}
          inert={!panelOpen}
          className="absolute inset-y-0 right-0 z-30 flex w-[min(440px,38vw)] flex-col border-l border-line bg-paper transition-transform duration-300 ease-out"
          style={{ transform: panelOpen ? "translateX(0)" : "translateX(100%)" }}
        >
          {focusedStory && <StoryPanel story={focusedStory} nameOf={nameOf} onClose={closeStory} onSelectCountry={select} />}
          {selected && (
            <CountryPanel
              country={selected}
              state={countryState}
              onClose={close}
              attention={hasAttention ? { mode: attentionMode, onMode: changeMode, mentions } : null}
              nameOf={nameOf}
              onSelect={select}
              filterAbout={filterAbout}
              onFilter={setFilterAbout}
              shared={sharedRefs}
              onStory={openStory}
            />
          )}
        </aside>
      ) : (
        <BottomSheet open={panelOpen} onClose={focusedStory ? closeStory : close} peek={SHEET_PEEK}>
          {focusedStory && <StoryPanel story={focusedStory} nameOf={nameOf} onClose={closeStory} onSelectCountry={select} />}
          {selected && (
            <CountryPanel
              country={selected}
              state={countryState}
              onClose={close}
              attention={hasAttention ? { mode: attentionMode, onMode: changeMode, mentions } : null}
              nameOf={nameOf}
              onSelect={select}
              filterAbout={filterAbout}
              onFilter={setFilterAbout}
              shared={sharedRefs}
              onStory={openStory}
            />
          )}
        </BottomSheet>
      )}
    </main>
  );
}
