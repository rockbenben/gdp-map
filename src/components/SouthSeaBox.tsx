import { useMemo } from 'react';
import { geoPath } from 'd3-geo';
import { chinaSouthSeaFeature, createSouthSeaProjection } from '../lib/geo';
import type { FeatureCollection } from '../lib/types';

interface Props {
  /** 包含南海诸岛要素的边界数据 */
  geo: FeatureCollection;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/** 南海诸岛小图（合规要求：竖版地图需附南海诸岛） */
export function SouthSeaBox({ geo, width = 108, height = 128, x = 0, y = 0 }: Props) {
  const sea = useMemo(() => {
    const feature = chinaSouthSeaFeature(geo);
    if (!feature) return null;
    const proj = createSouthSeaProjection(width - 16, height - 26, feature);
    return { path: geoPath(proj), feature };
  }, [geo, width, height]);

  if (!sea) return null;

  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect x={0} y={0} width={width} height={height} fill="rgba(9,14,26,0.6)" stroke="rgba(90,120,180,0.32)" strokeWidth={0.8} rx={4} />
      <text x={width / 2} y={height - 8} className="sea-label" textAnchor="middle">
        南海诸岛
      </text>
      <g transform={`translate(8, 6)`}>
        <path
          d={sea.path(sea.feature as never) ?? ''}
          fill="#3fd0c9"
          fillOpacity={0.55}
          stroke="#3fd0c9"
          strokeWidth={0.6}
        />
      </g>
    </g>
  );
}
