import { useCallback, useEffect, useMemo, useRef } from 'react';
import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';
import { featureArea } from '../lib/geo';
import type { FeatureCollection, GeoFeature } from '../lib/types';

export interface GlobeHighlight {
  id: string;
  label: string;
  gdp?: number;
  color: string;
}

interface Props {
  polygons: FeatureCollection;
  highlights: Map<string, GlobeHighlight>;
  sources?: Map<string, GlobeHighlight>;
  /** 弧线：起点/终点为经纬度 */
  arcs?: Array<{ start: [number, number]; end: [number, number]; color: string }>;
  onSelect?: (id: string) => void;
}

const SIZE = 800;
const RADIUS = 372;

/**
 * SVG 正射投影地球：正射投影本身就是「从无穷远看球面」的 3D 视图，
 * 不依赖 WebGL，导出 PNG 时与 2D 地图走同一条渲染管线。
 */
export function GlobeView({ polygons, highlights, sources = new Map(), arcs = [], onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const shadowRefs = useRef(new Map<string, SVGPathElement>());
  const labelRefs = useRef(new Map<string, SVGTextElement>());
  const arcRefs = useRef(new Map<string, SVGPathElement>());
  const originRef = useRef<SVGGElement | null>(null);
  const rotation = useRef<[number, number]>([110, -20]);
  const drag = useRef<{ x: number; y: number; lon: number; lat: number } | null>(null);
  const frame = useRef(0);

  const projection = useMemo(
    () => geoOrthographic().translate([SIZE / 2, SIZE / 2]).scale(RADIUS).clipAngle(90).precision(0.25),
    []
  );
  const path = useMemo(() => geoPath(projection), [projection]);

  const features = polygons.features;

  const labelTargets = useMemo(() => {
    const list: Array<{ id: string; label: string; color: string; area: number }> = [];
    for (const f of features) {
      const h = highlights.get(String(f.id));
      if (!h) continue;
      list.push({ id: String(f.id), label: h.label, color: h.color, area: featureArea(f) });
    }
    return list.sort((a, b) => b.area - a.area).slice(0, 14);
  }, [features, highlights]);

  const render = useCallback(() => {
    // d3 的 rotate 取的是「视角中心的反坐标」
    projection.rotate([-rotation.current[0], -rotation.current[1]]);

    for (const f of features) {
      const id = String(f.id);
      const d = path(f as never) ?? '';
      pathRefs.current.get(id)?.setAttribute('d', d);
      shadowRefs.current.get(id)?.setAttribute('d', d);
    }

    // 标签：只画在可见半球上，且相互避让
    const placed: Array<[number, number]> = [];
    for (const t of labelTargets) {
      const el = labelRefs.current.get(t.id);
      if (!el) continue;
      const f = features.find((x) => String(x.id) === t.id);
      if (!f) continue;
      const c = path.centroid(f as never);
      const visible = Number.isFinite(c[0]) && Math.hypot(c[0] - SIZE / 2, c[1] - SIZE / 2) < RADIUS - 6;
      const tooClose = placed.some(([x, y]) => Math.hypot(x - c[0], y - c[1]) < 30);
      if (!visible || tooClose) {
        el.setAttribute('opacity', '0');
        continue;
      }
      placed.push([c[0], c[1]]);
      el.setAttribute('opacity', '1');
      el.setAttribute('x', String(c[0]));
      el.setAttribute('y', String(c[1]));
    }

    // 弧线：球面两点之间的大圆插值，再向外鼓一点做出立体感。
    // 关键：被地球背面遮住的那一段不能连过去，否则线会横穿地图、端点对不上。
    for (const [i, arc] of arcs.entries()) {
      const el = arcRefs.current.get(String(i));
      if (!el) continue;
      const [lon1, lat1] = arc.start;
      const [lon2, lat2] = arc.end;
      const φ1 = (lat1 * Math.PI) / 180;
      const λ1 = (lon1 * Math.PI) / 180;
      const φ2 = (lat2 * Math.PI) / 180;
      const λ2 = (lon2 * Math.PI) / 180;
      const d =
        2 *
        Math.asin(
          Math.sqrt(
            Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
          )
        );

      const segments: string[][] = [];
      let current: string[] = [];
      const sinD = Math.sin(d);
      // 对跖点时 sin(d)=0，球面插值会算出 NaN，退化成经纬度线性插值
      const useSlerp = Math.abs(sinD) > 1e-6;
      for (let s = 0; s <= 48; s += 1) {
        const t = s / 48;
        let lon: number;
        let lat: number;
        if (!useSlerp) {
          lon = lon1 + (lon2 - lon1) * t;
          lat = lat1 + (lat2 - lat1) * t;
        } else {
          const A = Math.sin((1 - t) * d) / sinD;
          const B = Math.sin(t * d) / sinD;
          const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
          const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
          const z = A * Math.sin(φ1) + B * Math.sin(φ2);
          lon = (Math.atan2(y, x) * 180) / Math.PI;
          lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
        }
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const p = projection([lon, lat]);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          // 背面不可见：断开，别把两段直线连起来
          if (current.length > 1) segments.push(current);
          current = [];
          continue;
        }
        const bulge = 1 + 0.05 * Math.sin(Math.PI * t);
        const cx = SIZE / 2 + (p[0] - SIZE / 2) * bulge;
        const cy = SIZE / 2 + (p[1] - SIZE / 2) * bulge;
        current.push(`${cx.toFixed(1)},${cy.toFixed(1)}`);
      }
      if (current.length > 1) segments.push(current);

      el.setAttribute('d', segments.map((seg) => `M${seg.join('L')}`).join(' '));
      el.setAttribute('opacity', segments.length ? '1' : '0');
    }

    // 起点标记：所有弧线都从参照地区出发，标出来才看得出「谁对谁」
    const origin = originRef.current;
    if (origin) {
      const first = arcs[0];
      if (first) {
        const p = projection([first.start[0], first.start[1]]);
        if (p) {
          origin.setAttribute('transform', `translate(${p[0]}, ${p[1]})`);
          origin.setAttribute('opacity', '1');
        } else {
          origin.setAttribute('opacity', '0');
        }
      } else {
        origin.setAttribute('opacity', '0');
      }
    }
  }, [arcs, features, labelTargets, path, projection]);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const FRAME_MS = 55; // 约 18 帧/秒，避免把主线程占满
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      if (!drag.current) rotation.current[0] += 0.18;
      render();
    };
    raf = requestAnimationFrame(tick);
    frame.current = raf;
    return () => cancelAnimationFrame(raf);
  }, [render]);

  useEffect(() => {
    render();
  }, [render]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, lon: rotation.current[0], lat: rotation.current[1] };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    rotation.current[0] = drag.current.lon - dx * 0.35;
    rotation.current[1] = Math.max(-75, Math.min(75, drag.current.lat + dy * 0.35));
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const colorOf = (id: string) => highlights.get(id)?.color ?? sources.get(id)?.color ?? PALETTE_LAND;

  return (
    <div className="globe-wrap">
      <svg
        ref={svgRef}
        className="map-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="3D GDP 地球"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{ cursor: 'grab', touchAction: 'none' }}
      >
        <defs>
          <radialGradient id="globe-ocean" cx="38%" cy="32%" r="78%">
            <stop offset="0%" stopColor="#1b2a4c" />
            <stop offset="60%" stopColor="#101a33" />
            <stop offset="100%" stopColor="#060a14" />
          </radialGradient>
          <radialGradient id="globe-glow" cx="50%" cy="50%" r="50%">
            <stop offset="78%" stopColor="rgba(120,170,255,0)" />
            <stop offset="100%" stopColor="rgba(120,170,255,0.20)" />
          </radialGradient>
          <filter id="globe-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS + 10} fill="url(#globe-glow)" />

        <g className="globe-sphere">
          <path
            d={path({ type: 'Sphere' } as never) ?? ''}
            fill="url(#globe-ocean)"
            stroke="rgba(140,180,255,0.28)"
            strokeWidth={1}
          />
          <path
            d={path(geoGraticule10()) ?? ''}
            fill="none"
            stroke="rgba(140,180,255,0.13)"
            strokeWidth={0.6}
          />
        </g>

        <g className="globe-countries">
          {features.map((f: GeoFeature) => {
            const id = String(f.id);
            const h = highlights.get(id);
            const s = sources.get(id);
            const active = Boolean(h || s);
            return (
              <g key={id}>
                {active ? (
                  <path
                    ref={(el) => {
                      if (el) shadowRefs.current.set(id, el);
                      else shadowRefs.current.delete(id);
                    }}
                    className="globe-raise"
                    fill="#050810"
                    stroke="none"
                    transform="translate(3,4)"
                  />
                ) : null}
                <path
                  ref={(el) => {
                    if (el) pathRefs.current.set(id, el);
                    else pathRefs.current.delete(id);
                  }}
                  className="globe-country"
                  fill={active ? colorOf(id) : PALETTE_LAND}
                  fillOpacity={active ? 1 : 0.92}
                  stroke="rgba(6,10,20,0.6)"
                  strokeWidth={0.35}
                  onClick={() => onSelect?.(id)}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  <title>{h?.label ?? s?.label ?? f.properties.name ?? id}</title>
                </path>
              </g>
            );
          })}
        </g>

        <g className="globe-arcs">
          {arcs.map((arc, i) => (
            <path
              key={i}
              ref={(el) => {
                if (el) arcRefs.current.set(String(i), el);
                else arcRefs.current.delete(String(i));
              }}
              fill="none"
              stroke={arc.color}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeDasharray="5 6"
              opacity={0}
            />
          ))}
        </g>

        <g ref={originRef} className="globe-origin" opacity="0">
          <circle r={9} fill="none" stroke="#3fd0c9" strokeWidth={1.4} opacity={0.85} />
          <circle r={3.2} fill="#3fd0c9" />
        </g>

        <g className="globe-labels">          {labelTargets.map((t) => (
            <text
              key={t.id}
              ref={(el) => {
                if (el) labelRefs.current.set(t.id, el);
                else labelRefs.current.delete(t.id);
              }}
              className="map-label"
              fill={t.color}
              opacity={0}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}
        </g>
      </svg>
      <div className="globe-tip">拖动旋转 · 自动旋转中</div>
    </div>
  );
}

const PALETTE_LAND = '#2a3a5e';
