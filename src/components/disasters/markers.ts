// DOM for the globe's HTML layer: a clickable marker per disaster and small
// labelled dots for the selected disaster's places. Built outside React
// because the globe owns and positions these elements; styles live in the
// "Disaster markers" block at the end of globals.css.
import { DISASTER_META, SEVERITY_LABEL, iconSvg } from "@/lib/disasterMeta";
import type { MarkerItem, PlaceItem } from "@/lib/disasterLayers";

export interface MarkerHandlers {
  select: (id: string) => void;
  /** A cluster head was pressed: zoom towards the cluster's centre (or open the head when already close). */
  zoom: (id: string, lat: number, lng: number) => void;
  /** Called with the id on pointer enter, null on leave. */
  hover: (id: string | null) => void;
  /** Called with the id on keyboard focus, null on blur. */
  focus: (id: string | null) => void;
  /** A wheel turned over the marker, to pass on to the globe's zoom. */
  wheel: (e: WheelEvent) => void;
}

/**
 * A white chip with the type's icon over a halo that shows the hazard (see
 * the "Disaster markers" block in globals.css): ripples for a flood, a
 * flickering glow for a fire, a spinning spiral for a storm. Only severe
 * disasters, and the one selected or pointed at, show the halo; the rest
 * are plain chips. Disasters only located to a country get a dashed ring.
 * When markers overlap, the head of the cluster shows a count and pressing
 * it zooms in (see setMarkerCluster).
 */
export function createMarkerElement(m: MarkerItem, h: MarkerHandlers): HTMLElement {
  const meta = DISASTER_META[m.type];
  const el = document.createElement("div");
  el.className = "gv-dz";
  el.dataset.id = m.disasterId;
  el.dataset.type = m.type;
  el.dataset.sev = String(m.severity);
  el.dataset.precision = m.precision;
  // Southern storms turn clockwise.
  if (m.lat < 0) el.dataset.south = "";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.setAttribute("aria-label", m.label);
  el.dataset.label = m.label;
  el.dataset.title = m.title;
  el.style.setProperty("--dz-color", meta.color);
  el.style.setProperty("--dz-light", meta.light);
  el.style.setProperty("--dz-size", `${m.size}px`);
  // Static markup from our own icon table; the title only ever goes in attributes.
  el.innerHTML =
    '<span class="gv-dz-fx"><span class="gv-dz-halo"></span><span class="gv-dz-halo gv-dz-halo-late"></span></span>' +
    (m.precision === "country" ? '<span class="gv-dz-ring"></span>' : "") +
    '<span class="gv-dz-stem"></span>' +
    `<span class="gv-dz-chip">${iconSvg(m.type, Math.round(m.size * 0.58))}</span>` +
    '<span class="gv-dz-count" aria-hidden="true"></span>';

  // A cluster head zooms in; a lone marker opens its disaster.
  const press = () => {
    const lat = Number(el.dataset.clat);
    const lng = Number(el.dataset.clng);
    if (el.dataset.count && Number.isFinite(lat) && Number.isFinite(lng)) h.zoom(m.disasterId, lat, lng);
    else h.select(m.disasterId);
  };

  // The globe treats a press that reaches its container as a click on
  // whatever lies under the pointer; stop it so only the marker reacts.
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    press();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    press();
  });
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "touch") h.hover(m.disasterId);
  });
  el.addEventListener("pointerleave", () => h.hover(null));
  // Keyboard focus highlights the disaster like a hover and stops the globe
  // turning, so the focused marker cannot roll out of view.
  el.addEventListener("focus", () => h.focus(m.disasterId));
  el.addEventListener("blur", () => h.focus(null));
  // Markers sit outside the canvas, so the globe never sees a wheel over
  // them; pass it on, or zooming stops whenever a marker is under the pointer.
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      h.wheel(e);
    },
    { passive: false },
  );
  return el;
}

/** Moves a marker's chip by (dx, dy) px: onto a ring around its cluster's head when the cluster cannot be zoomed apart. */
export function setMarkerNudge(el: HTMLElement, dx: number, dy: number): void {
  const v = `${Math.round(dx)}px ${Math.round(dy)}px`;
  if ((el.dataset.nudge ?? "0px 0px") === v) return;
  el.dataset.nudge = v;
  el.style.setProperty("--dz-nudge", v);
}

/**
 * Makes a marker the head of a cluster of `count` others centred at
 * (lat, lng), or a lone marker again when count is 0. A head shows the
 * count and, when pressed, zooms in rather than opening its disaster.
 */
export function setMarkerCluster(el: HTMLElement, count: number, lat = 0, lng = 0): void {
  const value = count > 0 ? String(count) : "";
  if ((el.dataset.count ?? "") === value && (!value || (el.dataset.clat === String(lat) && el.dataset.clng === String(lng)))) return;
  if (value) {
    el.dataset.count = value;
    el.dataset.clat = String(lat);
    el.dataset.clng = String(lng);
    el.querySelector(".gv-dz-count")!.textContent = `+${count}`;
    el.setAttribute("aria-label", `${el.dataset.title ?? ""} and ${count} more ${count === 1 ? "disaster" : "disasters"} nearby. Zoom in`);
  } else {
    delete el.dataset.count;
    delete el.dataset.clat;
    delete el.dataset.clng;
    el.querySelector(".gv-dz-count")!.textContent = "";
    el.setAttribute("aria-label", el.dataset.label ?? "");
  }
}

/** Hides a marker merged into a cluster head (out of sight, out of the tab order), or shows it again. */
export function setMarkerMerged(el: HTMLElement, merged: boolean): void {
  if (el.classList.contains("gv-merged") === merged) return;
  el.classList.toggle("gv-merged", merged);
  if (merged && document.activeElement === el) el.blur();
  syncFocusable(el);
}

/** A marker can take focus only while it is on the near side and not merged into a cluster. */
function syncFocusable(el: HTMLElement): void {
  const reachable = !el.classList.contains("gv-hidden") && !el.classList.contains("gv-merged");
  const tab = reachable ? 0 : -1;
  if (el.tabIndex !== tab) el.tabIndex = tab;
  if (el.hasAttribute("aria-hidden") === reachable) {
    if (reachable) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", "true");
  }
}

/** Marks the selected marker and dims the rest while something is selected. */
export function setMarkerState(el: HTMLElement, selectedId: string | null): void {
  const id = el.dataset.id;
  el.classList.toggle("is-selected", !!selectedId && id === selectedId);
  el.classList.toggle("is-dim", !!selectedId && id !== selectedId);
}

/** A dot with the place's name and what happened there. Decorative for screen readers: the panel lists places. */
export function createPlaceElement(p: PlaceItem): HTMLElement {
  const el = document.createElement("div");
  el.className = `gv-place${p.nearMarker ? " is-near" : ""}${p.side === "left" ? " is-left" : ""}`;
  el.setAttribute("aria-hidden", "true");
  el.style.setProperty("--dz-color", DISASTER_META[p.type].color);
  const dot = document.createElement("span");
  dot.className = "gv-place-dot";
  const label = document.createElement("span");
  label.className = "gv-place-label";
  const name = document.createElement("strong");
  name.textContent = p.name;
  label.append(name);
  if (p.impact) {
    const impact = document.createElement("span");
    impact.textContent = p.impact;
    label.append(impact);
  }
  el.append(dot, label);
  return el;
}

/**
 * Puts a place's label on the given side of its dot, shortened (with an
 * ellipsis) when it is wider than the room there.
 */
export function setPlaceSide(el: HTMLElement, side: "left" | "right", room: number, labelPx: number): void {
  if (el.classList.contains("is-left") !== (side === "left")) el.classList.toggle("is-left", side === "left");
  const max = room < labelPx ? `min(13rem, 55vw, ${Math.max(48, Math.floor(room))}px)` : "";
  if (el.dataset.labelMax !== max) {
    el.dataset.labelMax = max;
    if (max) el.style.setProperty("--label-max", max);
    else el.style.removeProperty("--label-max");
  }
}

/** Width of a place's label in px, measured once (its text never changes). */
const labelWidths = new WeakMap<HTMLElement, number>();
export function placeLabelWidth(el: HTMLElement): number {
  let w = labelWidths.get(el);
  if (w === undefined) {
    w = (el.querySelector(".gv-place-label") as HTMLElement | null)?.offsetWidth ?? 0;
    if (w > 0) labelWidths.set(el, w); // 0 until the element is on the page
  }
  return w;
}

/**
 * Hides elements on the far side of the globe and keeps them out of the tab
 * order. The globe calls this for every element whenever the camera moves,
 * so it only touches the DOM when something changes. A focused marker is
 * never hidden from screen readers: it is blurred first.
 */
export function setElementVisible(el: HTMLElement, visible: boolean): void {
  if (el.classList.contains("gv-hidden") === visible) el.classList.toggle("gv-hidden", !visible);
  if (!el.classList.contains("gv-dz")) return;
  if (!visible && document.activeElement === el) el.blur();
  syncFocusable(el);
}

/** Tooltip text under a disaster's title: "Flood · Minor". */
export function tooltipDetail(type: MarkerItem["type"], severity: MarkerItem["severity"]): string {
  return `${DISASTER_META[type].label} · ${SEVERITY_LABEL[severity]}`;
}
