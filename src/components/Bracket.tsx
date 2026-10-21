import { useMemo } from 'react';

export interface Entrant {
  id: string;
  zh: string;
  /** 用于比大小的数值 */
  value: number;
  /** 展示用的数值文本 */
  text: string;
}

interface Props {
  entrants: Entrant[];
  /** 高亮这些参赛者的晋级路径 */
  highlightIds?: string[];
  width?: number;
  height?: number;
  onSelect?: (id: string) => void;
}

/**
 * 对阵树：把排名靠前的地区两两淘汰，每轮赢者晋级。
 * 看起来是一张「谁大谁小」的晋级图，点名字可以直接切换参照物。
 */
export function Bracket({ entrants, highlightIds = [], width = 1100, height = 560, onSelect }: Props) {
  const layout = useMemo(() => {
    const list = entrants.slice(0, 16);
    if (list.length < 4) return null;

    const rounds: Array<Array<{ y: number; id: string; text: string; value: number }>> = [];
    // 第 0 轮：每两个一格（顶部留出标题的位置）
    const topPad = 26;
    const rowH = (height - topPad) / list.length;
    const first = list.map((e, i) => ({
      y: topPad + i * rowH + rowH / 2,
      id: e.id,
      text: e.text,
      value: e.value
    }));
    rounds.push(first);

    // 后续轮次：两个子节点的中点
    let prev = first;
    while (prev.length > 1) {
      const next: Array<{ y: number; id: string; text: string; value: number }> = [];
      for (let i = 0; i < prev.length; i += 2) {
        const a = prev[i];
        const b = prev[i + 1];
        if (!b) {
          next.push(a);
          continue;
        }
        const win = a.value >= b.value ? a : b;
        next.push({ y: (a.y + b.y) / 2, id: win.id, text: win.text, value: win.value });
      }
      rounds.push(next);
      prev = next;
    }

    const colW = width / rounds.length;
    const nodeX = (r: number) => r * colW + 54;
    const edges: Array<{ x1: number; y1: number; x2: number; y2: number; win: boolean; highlight: boolean }> = [];

    for (let r = 0; r < rounds.length - 1; r += 1) {
      const cur = rounds[r];
      const nxt = rounds[r + 1];
      for (let m = 0; m < nxt.length; m += 1) {
        const a = cur[m * 2];
        const b = cur[m * 2 + 1];
        if (!a) continue;
        const target = nxt[m];
        for (const child of [a, b]) {
          if (!child) continue;
          edges.push({
            x1: nodeX(r) + 44,
            y1: child.y,
            x2: nodeX(r + 1),
            y2: target.y,
            win: child.id === target.id,
            highlight: Boolean(child.id && highlightIds.includes(child.id))
          });
        }
      }
    }

    return { rounds, nodeX, edges, list };
  }, [entrants, height, width, highlightIds]);

  if (!layout) return null;
  const { rounds, nodeX, edges, list } = layout;

  return (
    <svg
      className="map-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="对阵树"
      preserveAspectRatio="xMidYMid meet"
    >
      {edges.map((e, i) => (
        <path
          key={i}
          d={`M${e.x1},${e.y1} L${e.x1 + 14},${e.y1} L${e.x1 + 14},${e.y2} L${e.x2},${e.y2}`}
          fill="none"
          stroke={e.highlight ? 'rgba(246,196,83,0.75)' : e.win ? 'rgba(150,175,225,0.42)' : 'rgba(120,140,180,0.16)'}
          strokeWidth={e.highlight ? 1.8 : 1}
        />
      ))}

      {rounds.map((round, r) =>
        round.map((node, i) => {
          const highlight = node.id ? highlightIds.includes(node.id) : false;
          const isFinal = r === rounds.length - 1;
          return (
            <g key={`${r}-${i}`}>
              <circle
                cx={nodeX(r)}
                cy={node.y}
                r={isFinal ? 7 : 4.5}
                fill={highlight ? '#f6c453' : isFinal ? '#f6c453' : '#2a3550'}
                stroke={highlight || isFinal ? '#f6c453' : 'rgba(150,175,225,0.5)'}
                strokeWidth={1.4}
              />
              {node.id ? (
                <text
                  x={nodeX(r) + 12}
                  y={node.y + 4}
                  className="bracket-label"
                  fill={highlight ? '#f6c453' : '#c3cdea'}
                  onClick={() => onSelect?.(node.id)}
                  style={{ cursor: 'pointer' }}
                >
                  {node.text}
                </text>
              ) : null}
            </g>
          );
        })
      )}

      <text x={12} y={20} className="bracket-caption">
        前 {list.length} 名两两淘汰
      </text>
    </svg>
  );
}
