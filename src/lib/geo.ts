import { geoArea, geoCentroid, geoGraticule10, geoPath, geoNaturalEarth1, geoConicEqualArea } from 'd3-geo';
import type { GeoFeature, FeatureCollection } from './types';

/** 两个颜色之间线性插值（支持 #rgb / #rrggbb / rgb()） */
export function mixColor(a: string, b: string, t: number): string {
  const pa = parseRgb(a);
  const pb = parseRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function parseRgb(input: string): number[] {
  if (input.startsWith('#')) {
    const hex = input.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const m = input.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export const PALETTE = {
  ocean: '#0b1120',
  land: '#18213a',
  landStroke: '#26314f',
  matchedLow: '#f6c453',
  matchedHigh: '#ef4d4d',
  source: '#3fd0c9',
  label: '#eef2ff',
  labelDim: '#9aa7c7'
};

export function createWorldProjection(width: number, height: number) {
  return geoNaturalEarth1().fitExtent(
    [
      [8, 8],
      [width - 8, height - 8]
    ],
    { type: 'Sphere' } as never
  );
}

export function createWorldPath(width: number, height: number) {
  const projection = createWorldProjection(width, height);
  return {
    projection,
    path: geoPath(projection),
    graticule: geoPath(projection)(geoGraticule10())
  };
}

/** 中国主图（不含南海诸岛） */
export function chinaMainFeatures(geo: FeatureCollection): GeoFeature[] {
  return geo.features.filter((f) => !f.properties.isSouthSea);
}

export function chinaSouthSeaFeature(geo: FeatureCollection): GeoFeature | null {
  return geo.features.find((f) => f.properties.isSouthSea) ?? null;
}

export function createChinaProjection(width: number, height: number, features: GeoFeature[]) {
  const collection = { type: 'FeatureCollection' as const, features };
  return geoConicEqualArea()
    .parallels([25, 47])
    .rotate([-105, 0])
    .center([0, 36])
    .fitExtent(
      [
        [10, 10],
        [width - 10, height - 10]
      ],
      collection as never
    );
}

/** 南海诸岛小图（合规要求：竖版地图需附南海诸岛） */
export function createSouthSeaProjection(width: number, height: number, feature: GeoFeature) {
  return geoConicEqualArea()
    .parallels([15, 25])
    .rotate([-110, 0])
    .fitExtent(
      [
        [5, 5],
        [width - 5, height - 5]
      ],
      feature as never
    );
}

export function featureArea(f: GeoFeature): number {
  try {
    return geoArea(f as never);
  } catch {
    return 0;
  }
}

export function featureCentroid(f: GeoFeature): [number, number] {
  try {
    const c = geoCentroid(f as never);
    return [c[0], c[1]];
  } catch {
    return [0, 0];
  }
}

/**
 * 主体质心：只取面积最大的那个多边形。
 * 直接用 geoCentroid 会把离岛（法属圭亚那、夏威夷之类）一起算进去，
 * 质心会漂到海上，地图上的弧线就会「对不上地点」。
 */
export function featureMainCentroid(f: GeoFeature): [number, number] {
  try {
    const polys =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates as unknown]
        : (f.geometry.coordinates as unknown[]);
    let best: unknown = null;
    let bestArea = -1;
    for (const poly of polys) {
      const one = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } } as never;
      const area = Math.abs(geoArea(one));
      if (area > bestArea) {
        bestArea = area;
        best = one;
      }
    }
    if (!best) return featureCentroid(f);
    const c = geoCentroid(best as never);
    return [c[0], c[1]];
  } catch {
    return featureCentroid(f);
  }
}
