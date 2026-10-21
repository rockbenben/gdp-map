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
/** 把一个颜色调暗（k<0 变暗、k>0 变亮），用来给方块的侧面做出受光差异 */
function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)))
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

export function SquareCartogram({ items, width = 1100, height = 620, onSelect, labelFor }: Props) {
  // 立体：地面格子是原来的 treemap（面积 = 份额，一点没变），
  // 从地面往上立起方块，高度跟数值走——大块既占地大也高。
  // 投影是斜的：往右上方退，所以能看到左边和下边两个侧面。
  const HEADROOM = 96; // 顶部留出方块立起来要用的空间
  const cells = useMemo(() => {
    const usable = items.filter((i) => i.value > 0);
    if (!usable.length) return [];
    const root = hierarchy({ children: usable })
      .sum((d: unknown) => (d as SquareItem).value)
      .sort((a: { value?: number }, b: { value?: number }) => (b.value ?? 0) - (a.value ?? 0));
    treemap<{ children: SquareItem[] }>()
      .size([width, height - HEADROOM])
      .padding(2)
      .tile(treemapSquarify)
      .round(false)(root as never);
    const leaves = (
      root.leaves() as unknown as Array<{ data: SquareItem; x0: number; y0: number; x1: number; y1: number }>
    ).map((leaf) => ({
      ...leaf.data,
      x: leaf.x0,
      y: leaf.y0 + HEADROOM,
      w: leaf.x1 - leaf.x0,
      h: leaf.y1 - leaf.y0
    }));
    // 画家算法：离视线远的先画（左上），近的后画（左下），挡住关系才对
    return leaves.sort((a, b) => a.x + a.y - (b.x + b.y));
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
        const fill = c.matched ? mixColor(PALETTE.matchedLow, PALETTE.matchedHigh, t) : mixColor('#3b4e79', '#23314e', t);
        const label = labelFor ? labelFor(c.id) : c.zh;
        const showLabel = c.w > 46 && c.h > 22;
        // 方块高度：跟数值走，但用平方根压一下，不然最大的那块会把别的全挡住
        const H = 8 + Math.sqrt(c.value / maxValue) * 46;
        const dx = H * 0.42; // 往右退
        const dy = H * 0.55; // 往上升
        // 太小的格子不立起来：几十个微型国家挤在一起会变成一垛棍子
        const solid = c.w >= 18 && c.h >= 18;
        return (
          // 位置走 <g> 的 transform、尺寸走 rect 的几何属性：
          // 这两个都是能被 CSS transition 的 CSS 属性，换指标时格子会滑到新位置，
          // 而不是啪地重排一次。标签也跟着 <g> 一起走，不会和格子脱节。
          <g
            key={c.id}
            className="sq-cell"
            onClick={() => onSelect?.(c.id)}
            style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
          >
            {/* 地面：方块立起来之前的 footprint，面积=份额就看它 */}
            {solid ? <rect x={0} y={0} width={c.w} height={c.h} fill="#080d1a" opacity={0.9} /> : null}
            {/* 左侧面（背光，压暗） */}
            {solid ? (
              <polygon
                points={`0,0 ${dx},${-dy} ${dx},${c.h - dy} 0,${c.h}`}
                fill={shade(fill, -0.55)}
                stroke="rgba(6,10,20,0.65)"
                strokeWidth={0.6}
              />
            ) : null}
            {/* 底面（朝观众的那一面，最暗） */}
            {solid ? (
              <polygon
                points={`0,${c.h} ${dx},${c.h - dy} ${c.w + dx},${c.h - dy} ${c.w},${c.h}`}
                fill={shade(fill, -0.68)}
                stroke="rgba(6,10,20,0.65)"
                strokeWidth={0.6}
              />
            ) : null}
            {/* 顶面 */}
            <rect
              x={solid ? dx : 0}
              y={solid ? -dy : 0}
              width={c.w}
              height={c.h}
              fill={fill}
              stroke={c.matched ? 'rgba(255,255,255,0.6)' : 'rgba(10,16,30,0.75)'}
              strokeWidth={c.matched ? 1.2 : 0.7}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
            >
              <title>{`${label} · ${(share * 100).toFixed(2)}%`}</title>
            </rect>
            {/* 顶面受光的那条边：一条亮线，立体感就出来了 */}
            {solid ? (
              <path
                d={`M${dx},${-dy} L${dx + c.w},${-dy}`}
                stroke="rgba(255,255,255,0.22)"
                strokeWidth={1.1}
                fill="none"
              />
            ) : null}
            {showLabel ? (
              <text
                x={dx}
                y={-dy}
                textAnchor="middle"
                className="sq-label"
                fill={c.matched ? '#12182a' : '#a9b7d6'}
                style={{ transform: `translate(${c.w / 2}px, ${c.h / 2 + 4}px)` }}
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
