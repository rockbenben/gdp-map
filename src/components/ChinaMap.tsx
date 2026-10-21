import { useMemo } from 'react';
import { geoPath } from 'd3-geo';
import { chinaMainFeatures, chinaSouthSeaFeature, createChinaProjection, createSouthSeaProjection, mixColor, PALETTE } from '../lib/geo';
import type { FeatureCollection, GeoFeature } from '../lib/types';
import type { Highlight } from './WorldMap';

interface Props {
  geo: FeatureCollection;
  highlights: Highlight[];
  sources?: Highlight[];
  totalRanks: number;
  onSelect?: (id: string) => void;
  selectedIds?: string[];
  width?: number;
  height?: number;
}

export function ChinaMap({
  geo,
  highlights,
  sources = [],
  totalRanks,
  onSelect,
  selectedIds = [],
  width = 820,
  height = 640
}: Props) {
  const mainFeatures = useMemo(() => chinaMainFeatures(geo), [geo]);
  const seaFeature = useMemo(() => chinaSouthSeaFeature(geo), [geo]);

  const { path } = useMemo(() => {
    const projection = createChinaProjection(width, height, mainFeatures);
    return { path: geoPath(projection) };
  }, [width, height, mainFeatures]);

  const sea = useMemo(() => {
    if (!seaFeature) return null;
    const w = 108;
    const h = 128;
    const boxX = width - w - 18;
    const boxY = height - h - 18;
    const proj = createSouthSeaProjection(w - 16, h - 26, seaFeature);
    const p = geoPath(proj);
    return { path: p, x: boxX, y: boxY, w, h };
  }, [seaFeature, width, height]);

  const highlightMap = useMemo(() => new Map(highlights.map((h) => [h.id, h])), [highlights]);
  const sourceMap = useMemo(() => new Map(sources.map((h) => [h.id, h])), [sources]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const colorFor = (h: Highlight) => {
    const t = totalRanks <= 1 ? 0 : h.rank / (totalRanks - 1);
    return mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t);
  };

  return (
    <svg
      className="map-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="中国省级 GDP 等价地图"
      preserveAspectRatio="xMidYMid meet"
    >
      <g className="countries">
        {mainFeatures.map((f: GeoFeature) => {
          const id = String(f.id);
          const h = highlightMap.get(id);
          const s = sourceMap.get(id);
          const fill = h ? colorFor(h) : s ? PALETTE.source : PALETTE.land;
          const isDim = (highlights.length > 0 || sources.length > 0) && !h && !s;
          const isSelected = selectedSet.has(id);
          const clickable = Boolean(onSelect);
          return (
            <path
              key={id}
              d={path(f as never) ?? ''}
              fill={fill}
              fillOpacity={isDim ? 0.55 : 1}
              stroke={h || s ? 'rgba(255,255,255,0.7)' : PALETTE.landStroke}
              strokeWidth={h || s ? 1 : isSelected ? 1.6 : 0.4}
              className={clickable ? 'country hit' : 'country'}
              data-id={id}
              onClick={clickable ? () => onSelect?.(id) : undefined}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <title>
                {`${h?.label ?? s?.label ?? f.properties.name ?? id}${
                  h?.gdp ? ` · GDP ${(h.gdp / 1e12).toFixed(2)} 万亿美元` : ''
                }`}
              </title>
            </path>
          );
        })}
      </g>

      {sea ? (
        <g transform={`translate(${sea.x}, ${sea.y})`}>
          <rect x={0} y={0} width={sea.w} height={sea.h} fill="rgba(9,14,26,0.72)" stroke="#2b3a5c" strokeWidth={0.8} rx={4} />
          <text x={sea.w / 2} y={sea.h - 8} className="sea-label" textAnchor="middle">
            南海诸岛
          </text>
          <g transform={`translate(8, 6)`}>
            <path d={sea.path(seaFeature as never) ?? ''} fill={PALETTE.source} fillOpacity={0.55} stroke="#3fd0c9" strokeWidth={0.6} />
          </g>
        </g>
      ) : null}
    </svg>
  );
}
