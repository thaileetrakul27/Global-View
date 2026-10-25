import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Disaster } from "@/lib/data";
import CountryDisasters from "@/components/CountryDisasters";

const flood = (id: string, severity: Disaster["severity"]): Disaster => ({
  id,
  type: "flood",
  title: "Flood in Thailand",
  severity,
  countries: ["TH"],
  lat: 15,
  lng: 100,
  precision: "area",
  started: "2026-10-20T00:00:00Z",
  updated: "2026-10-21T00:00:00Z",
  areas: [],
  places: [{ name: "Mae Rim", country: "TH", lat: 18.9, lng: 98.9, kind: "district", source: "gdacs" }],
  figures: [],
  sources: [],
  appeals: [],
  donate: [],
  reportedBy: [],
  members: [],
});
const render = (disasters: Disaster[] | null, name = "Thailand") =>
  renderToStaticMarkup(
    createElement(CountryDisasters, { name, disasters, nameOf: (c: string) => c, onSelect: () => {}, onNews: () => {}, onClose: () => {} }),
  );

describe("CountryDisasters", () => {
  it("lists one row per disaster, each carrying its id so focus can come back to it", () => {
    const html = render([flood("a", 2), flood("b", 3)]);
    expect(html).toContain("Disasters in Thailand now");
    expect(html).toContain('data-disaster-id="a"');
    expect(html).toContain('data-disaster-id="b"');
    expect(html).toContain(">Significant<");
    expect(html).toContain(">Severe<");
    expect(html).toContain("Mae Rim");
    expect(html).not.toContain("No ongoing disasters");
  });
  it("says when there are none, with a way back to the country's news", () => {
    const html = render([], "Philippines");
    expect(html).toContain("No ongoing disasters in Philippines right now.");
    expect(html).toContain("See Philippines&#x27; news");
  });
  it("says nothing either way while the list loads", () => {
    const html = render(null);
    expect(html).not.toContain("No ongoing disasters");
    expect(html).not.toContain("data-disaster-id");
    expect(html).toContain("See Thailand&#x27;s news");
  });
});
