import { useMemo } from 'react';
import { createWorldPath, featureArea, mixColor, PALETTE } from '../lib/geo';
import type { FeatureCollection, GeoFeature } from '../lib/types';

export interface Highlight {
  /** 几何 id（世界地图用 ISO3） */
  id: string;
  /** 累加顺序，0 为最小 */
  rank: number;
  label: string;
  gdp?: number;
}

interface Props {
  geo: FeatureCollection;
  highlights: Highlight[];
  /** 参照对象（如被选中的国家），用另一种颜色 */
  sources?: Highlight[];
  totalRanks: number;
  onSelect?: (id: string) => void;
  /** 当前选中的 id，描边加粗 */
  selectedIds?: string[];
  /** 世界地图左下角的中国小图 */
  chinaInset?: React.ReactNode;
  width?: number;
  height?: number;
}

export function WorldMap({
  geo,
  highlights,
  sources = [],
  totalRanks,
  onSelect,
  selectedIds = [],
  chinaInset,
  width = 1000,
  height = 520
}: Props) {
  const { path, graticule } = useMemo(() => createWorldPath(width, height), [width, height]);

  const highlightMap = useMemo(() => new Map(highlights.map((h) => [h.id, h])), [highlights]);
  const sourceMap = useMemo(() => new Map(sources.map((h) => [h.id, h])), [sources]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const colorFor = (h: Highlight) => {
    const t = totalRanks <= 1 ? 0 : h.rank / (totalRanks - 1);
    return mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t);
  };

  const labels = useMemo(() => {
    const out: Array<{ id: string; x: number; y: number; text: string; color: string }> = [];
    const placed: Array<[number, number]> = [];
    const candidates = geo.features
      .map((f) => ({ f, h: highlightMap.get(String(f.id)) }))
      .filter((c): c is { f: GeoFeature; h: Highlight } => Boolean(c.h))
      .sort((a, b) => featureArea(b.f) - featureArea(a.f));

    for (const { f, h } of candidates) {
      if (out.length >= 16) break;
      if (featureArea(f) < 0.0009) continue; // 太小的不标注
      const centroid = path.centroid(f as never);
      if (!Number.isFinite(centroid[0])) continue;
      // 简单避让：离已放标签太近就跳过
      if (placed.some(([x, y]) => Math.hypot(x - centroid[0], y - centroid[1]) < 34)) continue;
      placed.push([centroid[0], centroid[1]]);
      out.push({ id: String(f.id), x: centroid[0], y: centroid[1], text: h.label, color: colorFor(h) });
    }
    return out;
  }, [geo.features, highlightMap, path, totalRanks]);

  return (
    <svg
      className="map-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="世界 GDP 等价地图"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <radialGradient id="ocean-grad" cx="50%" cy="42%" r="72%">
          <stop offset="0%" stopColor="#152039" />
          <stop offset="100%" stopColor="#080c16" />
        </radialGradient>
      </defs>

      <path d={path({ type: 'Sphere' } as never) ?? ''} fill="url(#ocean-grad)" stroke="#1d2740" strokeWidth={1} />

      <g className="graticule" fill="none" stroke="#1b2540" strokeWidth={0.5}>
        <path d={graticule ?? ''} />
      </g>

      <g className="countries">
        {geo.features.map((f: GeoFeature) => {
          const id = String(f.id);
          const h = highlightMap.get(id);
          const s = sourceMap.get(id);
          const d = path(f as never) ?? '';
          const fill = h ? colorFor(h) : s ? PALETTE.source : PALETTE.land;
          const isDim = (highlights.length > 0 || sources.length > 0) && !h && !s;
          const isSelected = selectedSet.has(id);
          const clickable = Boolean(onSelect);
          return (
            <path
              key={id}
              d={d}
              fill={fill}
              fillOpacity={isDim ? 0.5 : 1}
              stroke={h || s ? 'rgba(255,255,255,0.65)' : PALETTE.landStroke}
              strokeWidth={h || s ? 0.9 : isSelected ? 1.4 : 0.35}
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

      <g className="map-labels">
        {labels.map((l) => (
          <text key={l.id} x={l.x} y={l.y} className="map-label" fill={l.color}>
            {l.text}
          </text>
        ))}
      </g>

      {chinaInset ? <g className="china-inset">{chinaInset}</g> : null}
    </svg>
  );
}
