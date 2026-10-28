import { useMemo } from 'react';
import { geoEqualEarth, geoPath } from 'd3-geo';
import type { GeoFeature } from '../lib/types';

/**
 * 单个地区的等积投影剪影（盲猜用）。
 *
 * ⚠️ 这张 SVG 自己的可读文字不能写出答案——读屏用户直接就白拿了。
 * 所以 aria-label 只写「地区轮廓」。
 * （下面那四个选项按钮里当然有那个名字：答案就藏在选项里，那是玩法本身。）
 */
export function ShapeSilhouette({
  feature,
  width = 360,
  height = 220
}: {
  feature: GeoFeature;
  width?: number;
  height?: number;
}) {
  const d = useMemo(() => {
    const projection = geoEqualEarth().fitExtent(
      [
        [10, 10],
        [width - 10, height - 10]
      ],
      feature as never
    );
    return geoPath(projection)(feature as never) ?? '';
  }, [feature, width, height]);

  return (
    <svg
      className="shape-silhouette"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="地区轮廓"
      preserveAspectRatio="xMidYMid meet"
    >
      <path d={d} />
    </svg>
  );
}
