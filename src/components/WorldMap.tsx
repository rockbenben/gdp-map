import { useMemo } from 'react';
import { createWorldPath, featureArea, mixColor, PALETTE } from '../lib/geo';
import type { FeatureCollection, GeoFeature } from '../lib/types';

interface Highlight {
  /** 几何 id（世界地图用 ISO3） */
  id: string;
  /** 累加顺序，0 为最小 */
  rank: number;
  label: string;
  value?: number;
  /** 指定颜色（不给就按名次取渐变） */
  color?: string;
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
  /** 数值格式化（悬停提示用） */
  formatValue?: (value: number) => string;
  /** 悬停提示里的名字（中文）；不给就用 geo 里的英文名 */
  labelFor?: (id: string) => string;
  /** 世界地图左下角的中国小图 */
  chinaInset?: React.ReactNode;
  /** 省/州细分层（画在国家之上） */
  subdivisions?: FeatureCollection;
  /** 被高亮的省/州 */
  subHighlights?: Highlight[];
  /** 右下角的小图（如南海诸岛） */
  southSea?: React.ReactNode;
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
  formatValue,
  labelFor,
  chinaInset,
  subdivisions,
  subHighlights = [],
  southSea,
  width = 1000,
  height = 520
}: Props) {
  const { path, graticule } = useMemo(() => createWorldPath(width, height), [width, height]);

  const highlightMap = useMemo(() => new Map(highlights.map((h) => [h.id, h])), [highlights]);
  const subMap = useMemo(() => new Map(subHighlights.map((h) => [h.id, h])), [subHighlights]);
  const sourceMap = useMemo(() => new Map(sources.map((h) => [h.id, h])), [sources]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const colorFor = (h: Highlight) => {
    const t = totalRanks <= 1 ? 0 : h.rank / (totalRanks - 1);
    return mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t);
  };

  const labels = useMemo(() => {
    const out: Array<{ id: string; x: number; y: number; text: string; color: string }> = [];
    // 避让要算上标签的**宽度**：光比中心点距离，
    // 「马里 / 尼日尔 / 乍得 / 苏丹」这种挤在西非的一堆还是会叠在一起。
    const placed: Array<{ x: number; y: number; halfWidth: number }> = [];
    const candidates = geo.features
      .map((f) => ({ f, h: highlightMap.get(String(f.id)) }))
      .filter((c): c is { f: GeoFeature; h: Highlight } => Boolean(c.h))
      .sort((a, b) => featureArea(b.f) - featureArea(a.f));

    for (const { f, h } of candidates) {
      if (out.length >= 16) break;
      if (featureArea(f) < 0.0009) continue; // 太小的不标注
      const centroid = path.centroid(f as never);
      if (!Number.isFinite(centroid[0])) continue;
      // 13px 字号下一个汉字大约 13 个用户单位宽
      const halfWidth = (h.label.length * 13) / 2;
      const tooClose = placed.some(
        (p) => Math.hypot(p.x - centroid[0], p.y - centroid[1]) < p.halfWidth + halfWidth + 10
      );
      if (tooClose) continue;
      placed.push({ x: centroid[0], y: centroid[1], halfWidth });
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
          // 参照物可以有两个（两个地方对比），颜色由上层给，不能写死一种
          const fill = h ? colorFor(h) : s ? (s.color ?? PALETTE.source) : PALETTE.land;
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
                {`${h?.label ?? s?.label ?? (labelFor ? labelFor(id) : undefined) ?? f.properties.name ?? id}${
                  h?.value != null && formatValue ? ` · ${formatValue(h.value)}` : ''
                }`}
              </title>
            </path>
          );
        })}
      </g>

      {subdivisions ? (
        <g className="subdivisions">
          {subdivisions.features.map((f: GeoFeature) => {
            if (f.properties.isSouthSea) return null; // 南海诸岛走右下角小图
            const h = subMap.get(String(f.id));
            // 欧洲 NUTS-1 与日本都道府县：数量多，只在被高亮时才画，
            // 否则一百多个区一起描边会把欧洲糊成一片灰
            if (!h && f.properties.drawOnlyWhenHighlighted) return null;
            return (
              <path
                key={String(f.id)}
                d={path(f as never) ?? ''}
                fill={h ? (h.color ?? colorFor(h)) : 'none'}
                fillOpacity={h ? 0.95 : 0}
                stroke={h ? 'rgba(255,255,255,0.6)' : 'rgba(120,145,195,0.35)'}
                strokeWidth={h ? 0.7 : 0.3}
              >
                <title>
                  {`${h?.label ?? f.properties.zh ?? f.properties.name ?? f.id}${
                    h?.value != null && formatValue ? ` · ${formatValue(h.value)}` : ''
                  }`}
                </title>
              </path>
            );
          })}
        </g>
      ) : null}

      <g className="map-labels">
        {labels.map((l) => (
          <text key={l.id} x={l.x} y={l.y} className="map-label" fill={l.color}>
            {l.text}
          </text>
        ))}
      </g>

      {southSea ? <g className="south-sea">{southSea}</g> : null}
      {chinaInset ? <g className="china-inset">{chinaInset}</g> : null}
    </svg>
  );
}
