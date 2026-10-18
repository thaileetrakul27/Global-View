"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countryFocus, loadCountries, type CountryFeature } from "@/lib/geo";
import {
  loadAbout,
  loadAttention,
  loadCountry,
  loadCrises,
  loadHelp,
  loadHistoryIndex,
  loadIndex,
  loadShared,
  loadSnapshot,
  type AboutFile,
  type AttentionFile,
  type CountryFile,
  type CrisesFile,
  type HelpFile,
  type IndexFile,
  type SharedFile,
  type Snapshot,
  type SnapshotStory,
} from "@/lib/data";
import { needFor } from "@/lib/help";
import { displayName } from "@/lib/names";
import { inbound, mostWatched, outbound, tintMap } from "@/lib/attention";
import { readUrlState, writeUrlState } from "@/lib/urlState";
import { useViewport } from "@/lib/useViewport";
import GlobeView from "./GlobeView";
import type { GlobeArc } from "./Globe";
import CountrySearch from "./CountrySearch";
import CountryPanel, { type CountryState } from "./CountryPanel";
import type { AttentionMode } from "./AttentionChips";
import BottomSheet from "./BottomSheet";
import WorldStories from "./WorldStories";
import StoryPanel from "./StoryPanel";
import WorldSummary from "./WorldSummary";
import TimeControl from "./TimeControl";
import CrisisCard from "./CrisisCard";
import CrisisStrip from "./CrisisStrip";
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
  // Time machine: archived days, the one being viewed, and loaded snapshots.
  const [historyDates, setHistoryDates] = useState<string[]>([]);
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot | null>>({});
  // Foreign articles about each country, fetched when its inbound view opens.
  const [abouts, setAbouts] = useState<Record<string, AboutFile | null>>({});
  const [crises, setCrises] = useState<CrisesFile | null>(null);
  const [help, setHelp] = useState<HelpFile | null>(null);
  // Country files already fetched, keyed by code. Null marks "no file".
  const [files, setFiles] = useState<Record<string, CountryFile | null | "error">>({});
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const vp = useViewport();

  // The address the page opened with, so a shared link can be applied once
  // the data it points at has loaded. Not rendered, so it is safe to read
  // during the first client render.
  const [initialSearch] = useState(() => (typeof window === "undefined" ? "" : window.location.search));
  const urlApplied = useRef(false);

  useEffect(() => {
    const wanted = readUrlState(initialSearch);
    loadCountries()
      .then((list) => {
        setCountries(list);
        const codes = new Set(list.map((c) => c.properties.code));
        if (wanted.country && codes.has(wanted.country)) {
          setSelectedCode(wanted.country);
          setFilterAbout(wanted.about && codes.has(wanted.about) ? wanted.about : null);
        }
        urlApplied.current = true;
      })
      .catch(console.error);
    loadIndex().then(setIndex).catch(console.error);
    loadShared()
      .then((data) => {
        setShared(data);
        if (wanted.story && data?.stories.some((st) => st.id === wanted.story)) setFocusStoryId(wanted.story);
      })
      .catch(console.error);
    loadAttention().then(setAttention).catch(console.error);
    loadCrises().then(setCrises).catch(console.error);
    loadHelp().then(setHelp).catch(console.error);
    loadHistoryIndex()
      .then((h) => {
        const dates = h?.dates ?? [];
        setHistoryDates(dates);
        if (wanted.date && dates.includes(wanted.date)) setHistoryDate(wanted.date);
      })
      .catch(console.error);
  }, [initialSearch]);

  // Fetch a snapshot the first time its day is viewed.
  useEffect(() => {
    if (!historyDate || historyDate in snapshots) return;
    const date = historyDate;
    loadSnapshot(date)
      .then((snap) => setSnapshots((m) => ({ ...m, [date]: snap })))
      .catch((err) => {
        console.error(err);
        setSnapshots((m) => ({ ...m, [date]: null }));
      });
  }, [historyDate, snapshots]);
  const snapshot = historyDate ? (snapshots[historyDate] ?? null) : null;
  const historyLabel = historyDate
    ? new Date(`${historyDate}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : null;

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

  // What kind of coverage each country has, for colouring the globe.
  const coverage = useMemo(() => {
    const m = new Map<string, "local" | "world">();
    for (const [code, entry] of Object.entries(index?.countries ?? {})) m.set(code, entry.kind ?? "local");
    return m;
  }, [index]);
  const editions = useMemo(() => [...coverage.values()].filter((k) => k === "local").length, [coverage]);

  // Lookups by country code: display name and a point to draw arcs from.
  const byCode = useMemo(() => new Map(countries.map((c) => [c.properties.code, c])), [countries]);
  const nameOf = useCallback((code: string) => displayName(code, byCode.get(code)?.properties.name), [byCode]);
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
  // Stories for the current day: the archive's when a past day is viewed.
  const dayStories = useMemo<SnapshotStory[]>(
    () =>
      historyDate
        ? (snapshot?.stories ?? [])
        : (shared?.stories ?? []).map((s) => ({ id: s.id, title: s.title, subject: s.subject ?? null, countries: s.countries })),
    [historyDate, snapshot, shared],
  );

  /** Most reader countries drawn for the landing story. */
  const LANDING_ARCS = 20;

  const arcs = useMemo<GlobeArc[]>(() => {
    const stories = dayStories;
    let picked: { story: SnapshotStory; strength: number; limit: number }[];
    if (selectedCode) {
      // The selected country's three most-shared stories; everything it
      // shares with anyone would be a burst of dozens of lines.
      picked = stories
        .filter((s) => s.countries.includes(selectedCode))
        .slice(0, 3)
        .map((story) => ({ story, strength: 1, limit: LANDING_ARCS }));
    } else if (focusStoryId) {
      picked = stories.filter((s) => s.id === focusStoryId).map((story) => ({ story, strength: 1, limit: Infinity }));
    } else {
      // Only the most-shared story, and only its strongest readers, so the
      // landing globe stays calm.
      picked = stories.slice(0, 1).map((story) => ({ story, strength: 0.4, limit: LANDING_ARCS }));
    }
    const out = new Map<string, GlobeArc>();
    for (const { story, strength, limit } of picked) {
      const hub =
        selectedCode && story.countries.includes(selectedCode)
          ? selectedCode
          : story.subject && centroids.has(story.subject)
            ? story.subject
            : story.countries[0];
      const from = centroids.get(hub);
      if (!from) continue;
      let drawn = 0;
      for (const code of story.countries) {
        if (code === hub || drawn >= limit) continue;
        drawn++;
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
  }, [dayStories, selectedCode, focusStoryId, centroids]);

  // World-coverage countries have no "own news", so only the inbound view applies.
  const selectedKind = selectedCode ? (coverage.get(selectedCode) ?? "local") : "local";
  const effectiveMode: AttentionMode = selectedKind === "world" ? "inbound" : attentionMode;

  // Fetch the "about" file the first time a country's inbound view is shown.
  // Countries nobody writes about have no file, which loads as null.
  // The attention counts already say whether anything exists, so countries
  // nobody writes about never request a file.
  const hasInbound = !!selectedCode && inbound(attention, selectedCode, 1).length > 0;
  const wantAbout = selectedCode && !historyDate && effectiveMode === "inbound" && hasInbound ? selectedCode : null;
  useEffect(() => {
    if (!wantAbout || wantAbout in abouts) return;
    const code = wantAbout;
    loadAbout(code)
      .then((file) => setAbouts((m) => ({ ...m, [code]: file })))
      .catch((err) => {
        console.error(err);
        setAbouts((m) => ({ ...m, [code]: null }));
      });
  }, [wantAbout, abouts]);

  // Tints: who the selected country is reading about, or who reads about it.
  // Attention is not archived, so past days show none.
  const mentions = useMemo(
    () =>
      selectedCode && !historyDate
        ? effectiveMode === "outbound"
          ? outbound(attention, selectedCode, 12)
          : inbound(attention, selectedCode, 12)
        : [],
    [attention, selectedCode, effectiveMode, historyDate],
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

  // Keep the address bar and title in step with what is open.
  useEffect(() => {
    if (!urlApplied.current) return;
    const query = writeUrlState({
      country: selectedCode ?? undefined,
      about: filterAbout ?? undefined,
      story: focusStoryId ?? undefined,
      date: historyDate ?? undefined,
    });
    const url = `${window.location.pathname}${query}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
    const selectedName = selectedCode ? byCode.get(selectedCode)?.properties.name : undefined;
    const title = focusedStory
      ? `${focusedStory.title} · Global View`
      : selectedName
        ? `${selectedName} · Global View`
        : "Global View";
    document.title = title;
    // Next applies the static page title once hydration settles, which can
    // land after a fast data load; set it again shortly after.
    const t = setTimeout(() => (document.title = title), 1500);
    return () => clearTimeout(t);
  }, [selectedCode, filterAbout, focusStoryId, focusedStory, byCode, historyDate]);

  const topStory = dayStories[0] ?? null;
  const selectedNeed = useMemo(() => (selectedCode && crises ? needFor(selectedCode, crises, help) : undefined), [crises, help, selectedCode]);
  const watched = useMemo(() => mostWatched(attention, 1)[0] ?? null, [attention]);

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
  // Changing day keeps the country but drops anything that needs live data.
  const changeDate = useCallback((date: string | null) => {
    setHistoryDate(date);
    setFocusStoryId(null);
    setStoryFrom(null);
    setFilterAbout(null);
  }, []);
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
        coverage={coverage}
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
          {!panelOpen && (
            <WorldSummary
              topStory={topStory}
              mostWatched={watched}
              nameOf={nameOf}
              onStory={openStory}
              onCountry={(c) => select(c)}
              past={historyLabel}
            />
          )}
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

      {(historyDates.length > 1 || historyDate) && (
        <div
          className={`pointer-events-none absolute z-20 flex justify-center ${
            vp.isDesktop ? "inset-x-0 bottom-14" : "inset-x-0 top-[7.5rem]"
          } ${!vp.isDesktop && panelOpen ? "hidden" : ""}`}
        >
          <TimeControl dates={historyDates} date={historyDate} onChange={changeDate} />
        </div>
      )}

      {!selected && !focusedStory && !historyDate && crises && vp.isDesktop && (
        <div className="pointer-events-none absolute right-5 top-28 z-20 sm:right-7">
          <CrisisCard crises={crises} help={help} nameOf={nameOf} onSelect={(c) => select(c)} />
        </div>
      )}

      {!panelOpen && !historyDate && crises && !vp.isDesktop && (
        <div className="pointer-events-none absolute inset-x-0 bottom-11 z-20">
          <CrisisStrip crises={crises} help={help} nameOf={nameOf} onSelect={(c) => select(c)} />
        </div>
      )}

      {!selected && !focusedStory && dayStories.length > 0 && vp.isDesktop && (
        <div className="pointer-events-none absolute bottom-6 left-5 z-20 sm:left-7">
          <WorldStories
            stories={dayStories}
            focusId={focusStoryId}
            onFocus={openStory}
            nameOf={nameOf}
            heading={historyLabel ? `Stories the world shared on ${historyLabel}` : "Stories the world shares"}
            interactive={!historyDate}
          />
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
              attention={
                hasAttention
                  ? { mode: effectiveMode, onMode: changeMode, mentions, inboundOnly: selectedKind === "world" }
                  : null
              }
              nameOf={nameOf}
              onSelect={select}
              filterAbout={filterAbout}
              onFilter={setFilterAbout}
              shared={sharedRefs}
              onStory={openStory}
              name={nameOf(selected.properties.code)}
              need={selectedNeed}
              about={{
                articles: !hasInbound
                  ? []
                  : selected.properties.code in abouts
                    ? (abouts[selected.properties.code]?.articles ?? [])
                    : null,
                editions,
              }}
              history={
                historyDate && historyLabel
                  ? { label: historyLabel, articles: snapshot?.countries[selected.properties.code] ?? null }
                  : null
              }
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
              attention={
                hasAttention
                  ? { mode: effectiveMode, onMode: changeMode, mentions, inboundOnly: selectedKind === "world" }
                  : null
              }
              nameOf={nameOf}
              onSelect={select}
              filterAbout={filterAbout}
              onFilter={setFilterAbout}
              shared={sharedRefs}
              onStory={openStory}
              name={nameOf(selected.properties.code)}
              need={selectedNeed}
              about={{
                articles: !hasInbound
                  ? []
                  : selected.properties.code in abouts
                    ? (abouts[selected.properties.code]?.articles ?? [])
                    : null,
                editions,
              }}
              history={
                historyDate && historyLabel
                  ? { label: historyLabel, articles: snapshot?.countries[selected.properties.code] ?? null }
                  : null
              }
            />
          )}
        </BottomSheet>
      )}
    </main>
  );
}
