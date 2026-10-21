import { useMemo } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { mixColor, PALETTE } from '../lib/geo';

export interface SquareItem {
  id: string;
  zh: string;
  value: number;
  /** 是否属于当前对照结果 */
  matched?: boolean;
}

interface Props {
  items: SquareItem[];
  width?: number;
  height?: number;
  onSelect?: (id: string) => void;
  labelFor?: (id: string) => string;
}

/**
 * 方形图（square cartogram）：每个国家缩成一块，面积 = 当前指标。
 * 用 squarify 铺排，大国块大、小国块小，一眼看出「谁撑起了世界经济」。
 */
export function SquareCartogram({ items, width = 1100, height = 620, onSelect, labelFor }: Props) {
  const cells = useMemo(() => {
    const usable = items.filter((i) => i.value > 0);
    if (!usable.length) return [];
    const root = hierarchy({ children: usable })
      .sum((d: unknown) => (d as SquareItem).value)
      .sort((a: { value?: number }, b: { value?: number }) => (b.value ?? 0) - (a.value ?? 0));
    treemap<{ children: SquareItem[] }>()
      .size([width, height])
      .padding(2)
      .tile(treemapSquarify)
      .round(false)(root as never);
    return (root.leaves() as unknown as Array<{ data: SquareItem; x0: number; y0: number; x1: number; y1: number }>).map((leaf) => ({
      ...leaf.data,
      x: leaf.x0,
      y: leaf.y0,
      w: leaf.x1 - leaf.x0,
      h: leaf.y1 - leaf.y0
    }));
  }, [items, width, height]);

  const total = useMemo(() => items.reduce((s, i) => s + Math.max(0, i.value), 0), [items]);
  const maxValue = useMemo(() => Math.max(...items.map((i) => i.value), 1), [items]);

  return (
    <svg
      className="map-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="方形图"
      preserveAspectRatio="xMidYMid meet"
    >
      {cells.map((c) => {
        const share = c.value / total;
        const t = 1 - Math.sqrt(c.value / maxValue);
        const fill = c.matched ? mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t) : mixColor('#2b3a5c', '#1b2740', t);
        const label = labelFor ? labelFor(c.id) : c.zh;
        const showLabel = c.w > 46 && c.h > 22;
        return (
          <g key={c.id} className="sq-cell" onClick={() => onSelect?.(c.id)}>
            <rect
              x={c.x}
              y={c.y}
              width={c.w}
              height={c.h}
              fill={fill}
              stroke={c.matched ? 'rgba(255,255,255,0.55)' : 'rgba(10,16,30,0.6)'}
              strokeWidth={c.matched ? 1.2 : 0.6}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
            >
              <title>{`${label} · ${(share * 100).toFixed(2)}%`}</title>
            </rect>
            {showLabel ? (
              <text
                x={c.x + c.w / 2}
                y={c.y + c.h / 2 + 4}
                textAnchor="middle"
                className="sq-label"
                fill={c.matched ? '#12182a' : '#a9b7d6'}
              >
                {label.length > 6 ? `${label.slice(0, 6)}…` : label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
