import { describe, expect, it } from "vitest";
import { countriesNear, degreesToBox, detailReach, featureBoxes, type CountryFeature } from "../geo";

function feature(code: string, polygons: number[][][][]): CountryFeature {
  return {
    type: "Feature",
    properties: { code, name: code, admin: code },
    geometry: { type: "MultiPolygon", coordinates: polygons },
  };
}

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number) => [
  [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ],
];

describe("detailed shapes near the camera", () => {
  it("boxes each polygon separately, so a country split at the antimeridian stays two small boxes", () => {
    const fiji = feature("FJ", [box(177, -19, 180, -16), box(-180, -17, -179.8, -16)]);
    const boxes = featureBoxes(fiji);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({ minLat: -19, maxLat: -16, minLng: 177, maxLng: 180 });
  });

  it("measures the distance from a point to a box in degrees, 0 inside", () => {
    const b = { minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 };
    expect(degreesToBox(5, 5, b)).toBe(0);
    expect(degreesToBox(15, 5, b)).toBeCloseTo(5, 5);
    expect(degreesToBox(0, -3, b)).toBeCloseTo(3, 5);
    // The short way round the antimeridian.
    expect(degreesToBox(0, -178, { minLat: -1, maxLat: 1, minLng: 175, maxLng: 180 })).toBeCloseTo(2, 5);
  });

  it("finds the countries within reach of the view, more of them from higher up", () => {
    const boxes = new Map([
      ["LY", featureBoxes(feature("LY", [box(9, 19, 25, 33)]))],
      ["IT", featureBoxes(feature("IT", [box(6, 36, 19, 47)]))],
      ["BR", featureBoxes(feature("BR", [box(-74, -34, -34, 5)]))],
    ]);
    expect(countriesNear(boxes, 32.4, 15.1, detailReach(0.1))).toEqual(["LY", "IT"]);
    expect(countriesNear(boxes, 32.4, 15.1, 1)).toEqual(["LY"]);
    expect(detailReach(0.1)).toBeLessThan(detailReach(0.7));
    expect(detailReach(5)).toBe(60);
  });
});
