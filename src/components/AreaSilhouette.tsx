import { useMemo } from 'react';
import { geoEqualEarth, geoPath } from 'd3-geo';
import type { GeoFeature } from '../lib/types';

interface Props {
  /** 参照物的轮廓（地方 → 世界时是省/州，世界 → 地方时是国家） */
  source: GeoFeature | null;
  /** 对照对象的轮廓（地方 → 世界时是国家，世界 → 地方时是省/州） */
  target: GeoFeature | null;
  sourceLabel: string;
  targetLabel: string;
  sourceArea?: string;
  targetArea?: string;
  width?: number;
  height?: number;
}

/**
 * 同一比例尺的剪影对照。
 * 用等积投影（geoEqualEarth）保证画出来的大小就是真实大小之比，
 * 否则高纬度国家会被投影放大，对比就不公平了。
 */
export function AreaSilhouette({
  source,
  target,
  sourceLabel,
  targetLabel,
  sourceArea,
  targetArea,
  width = 320,
  height = 190
}: Props) {
  const layout = useMemo(() => {
    if (!source || !target) return null;

    const probe = geoEqualEarth().scale(1).translate([0, 0]);
    const probePath = geoPath(probe);
    const b1 = probePath.bounds(source as never);
    const b2 = probePath.bounds(target as never);
    const w = Math.max(b1[1][0] - b1[0][0], b2[1][0] - b2[0][0]);
    const h = Math.max(b1[1][1] - b1[0][1], b2[1][1] - b2[0][1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0) return null;

    const pad = 8;
    const halfW = width / 2;
    const scale = Math.min((halfW - pad) / w, (height - pad * 2 - 18) / h);

    const place = (b: [[number, number], [number, number]], cx: number) => {
      const centerX = (b[0][0] + b[1][0]) / 2;
      const centerY = (b[0][1] + b[1][1]) / 2;
      const proj = geoEqualEarth().scale(scale).translate([cx - centerX * scale, height / 2 - centerY * scale]);
      return geoPath(proj);
    };

    return {
      sourcePath: place(b1, halfW / 2),
      targetPath: place(b2, halfW + halfW / 2)
    };
  }, [source, target, width, height]);

  if (!source || !target || !layout) return null;

  return (
    <figure className="silhouette">
      <div className="silhouette-panels">
        <svg viewBox={`0 0 ${width / 2} ${height}`} className="silhouette-svg">
          <path d={layout.sourcePath(source as never) ?? ''} fill="#3fd0c9" fillOpacity={0.85} stroke="#0a1120" strokeWidth={0.6} />
        </svg>
        <svg viewBox={`${width / 2} 0 ${width / 2} ${height}`} className="silhouette-svg">
          <path d={layout.targetPath(target as never) ?? ''} fill="#f6c453" fillOpacity={0.85} stroke="#0a1120" strokeWidth={0.6} />
        </svg>
      </div>
      <figcaption>
        <span>
          <i className="dot teal" />
          {sourceLabel}
          {sourceArea ? ` · ${sourceArea}` : ''}
        </span>
        <span>
          <i className="dot gold" />
          {targetLabel}
          {targetArea ? ` · ${targetArea}` : ''}
        </span>
        <em>同一比例尺 · 等积投影</em>
      </figcaption>
    </figure>
  );
}
