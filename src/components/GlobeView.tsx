import { useCallback, useEffect, useMemo, useRef } from 'react';
import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';
import { featureArea, PALETTE } from '../lib/geo';
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
 * 滚转角：d3 的 rotate 第三个参数是把球往「侧面倒」的角度。
 * 原来取 0，球是正对着看的，看起来就是一张平涂的圆盘；倒 16° 之后
 * 能看见北极斜着退到后���去，立刻像一只立起来的地球仪。
 */
const ROLL = -16;
/** 大气辉光的厚度（像素） */
const ATMO = 26;

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
  /** 甩手的速度：松手后靠它惯性继续转 */
  const spin = useRef({ lon: 0, lat: 0 });
  const frame = useRef(0);

  const projection = useMemo(
    () => geoOrthographic().translate([SIZE / 2, SIZE / 2]).scale(RADIUS).clipAngle(90).precision(0.25),
    []
  );
  const path = useMemo(() => geoPath(projection), [projection]);

  const features = polygons.features;

  /**
   * 星空：固定的一批小点。
   *
   * 用固定种子生成，随机数每次渲染都一样——不然每次转都换一批星，像在闪。
   * 只用圆点不用滤镜：导出会把 filter 属性摘掉（filters 太慢），
   * 用滤镜做的星光在导出的图里就没了。
   */
  const stars = useMemo(() => {
    let seed = 20241021;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: 180 }, () => ({
      x: rand() * SIZE,
      y: rand() * SIZE,
      r: 0.4 + rand() * 1.15,
      o: 0.14 + rand() * 0.46
    }));
  }, []);

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
    // d3 的 rotate 取的是「视角中心的反坐标」，第三个参数是滚转（把球侧倒）
    projection.rotate([-rotation.current[0], -rotation.current[1], ROLL]);

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
        // 往外鼓一点，做出「贴着球面绕过去」的感觉。
        // ⚠️ 但不能鼓出球面：鼓出是相对球心算的，弧线走到球缘时会被推出去 5% 的半径，
        // 甩到轮廓外面像一团面条。所以夹住：最多到球面为止。
        const bulge = 1 + 0.05 * Math.sin(Math.PI * t);
        const dx = p[0] - SIZE / 2;
        const dy = p[1] - SIZE / 2;
        const dist = Math.hypot(dx, dy);
        const scale = dist > 0 ? Math.min(bulge, RADIUS / dist) : bulge;
        const cx = SIZE / 2 + dx * scale;
        const cy = SIZE / 2 + dy * scale;
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
    // 每帧要重算 261 条路径的球面坐标，实测满帧只能跑 30 fps，
    // 所以节流到 30 帧：拖动时明显比原来的 18 帧跟手，又不至于把主线程占满。
    const FRAME_MS = 33;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      if (!drag.current) {
        // 松手后靠惯性继续转，转速每帧衰减；慢到一定程度就交回自动旋转
        if (Math.abs(spin.current.lon) > 0.01 || Math.abs(spin.current.lat) > 0.01) {
          rotation.current[0] += spin.current.lon;
          rotation.current[1] = Math.max(-75, Math.min(75, rotation.current[1] + spin.current.lat));
          spin.current.lon *= 0.94;
          spin.current.lat *= 0.94;
        } else {
          rotation.current[0] += 0.18;
        }
      }
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
    // 记下这一帧甩了多快：松手之后靠它继续转
    spin.current.lon = -dx * 0.35;
    spin.current.lat = dy * 0.35;
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const colorOf = (id: string) => highlights.get(id)?.color ?? sources.get(id)?.color ?? PALETTE.globeLand;

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
          {/* 球面明暗：光源固定在左上方，往背光面渐暗。没有这一层，
              球就只是一张贴了图的圆盘，看不出体积。 */}
          <radialGradient id="globe-shade" cx="32%" cy="26%" r="78%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.10)" />
            <stop offset="34%" stopColor="rgba(0,0,0,0)" />
            <stop offset="74%" stopColor="rgba(3,6,16,0.42)" />
            <stop offset="100%" stopColor="rgba(2,4,10,0.78)" />
          </radialGradient>
          {/* 大气层：贴着球边的一圈蓝，越往外越淡 */}
          <radialGradient id="globe-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(90,150,255,0)" />
            <stop offset="86%" stopColor="rgba(96,152,255,0.16)" />
            <stop offset="94%" stopColor="rgba(120,180,255,0.30)" />
            <stop offset="100%" stopColor="rgba(120,180,255,0)" />
          </radialGradient>
          <radialGradient id="globe-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(70,120,220,0)" />
            <stop offset="82%" stopColor="rgba(70,120,220,0.10)" />
            <stop offset="100%" stopColor="rgba(70,120,220,0)" />
          </radialGradient>
          {/* 高光：光源那一侧的一点反光，球面才有「瓷」的感觉 */}
          <radialGradient id="globe-spec" cx="34%" cy="27%" r="30%">
            <stop offset="0%" stopColor="rgba(214,232,255,0.17)" />
            <stop offset="100%" stopColor="rgba(214,232,255,0)" />
          </radialGradient>
          <filter id="globe-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* 星空 */}
        <g className="globe-stars">
          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={`rgba(214,228,255,${s.o.toFixed(2)})`} />
          ))}
        </g>

        {/* 大气：外圈的光晕 + 贴着球的一层 */}
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS + ATMO * 1.5} fill="url(#globe-halo)" />
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS + ATMO * 0.5} fill="url(#globe-glow)" />

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
            stroke="rgba(150,190,255,0.19)"
            strokeWidth={0.6}
          />
        </g>

        <g className="globe-countries">
          {features.map((f: GeoFeature) => {
            const id = String(f.id);
            const h = highlights.get(id);
            const s = sources.get(id);
            const active = Boolean(h || s);
            // 欧洲 NUTS-1 与日本都道府县：不被高亮就不画。
            // 跟 2D 地图一个道理——一百多个区一起画会把欧洲糊成马赛克。
            if (!active && f.properties?.drawOnlyWhenHighlighted) return null;
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
                  fill={active ? colorOf(id) : PALETTE.globeLand}
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

        {/* 明暗层压在国家之上、弧线之下：国家跟着球面一起明暗，
            弧线与标注保持清晰可读 */}
        <circle
          className="globe-shade-layer"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="url(#globe-shade)"
          pointerEvents="none"
        />
        <circle
          className="globe-spec-layer"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="url(#globe-spec)"
          pointerEvents="none"
        />

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
