import { useEffect, useRef } from 'react';

interface Props {
  /** 目标值 */
  value: number;
  /** 数字怎么写（滚动过程中每一帧都用它） */
  format?: (v: number) => string;
  /** 动画时长（毫秒） */
  duration?: number;
  /** 要不要滚。关掉就一步到位——由 App 按「系统偏好 + 用户选择」算出来传进来 */
  animate?: boolean;
}

/**
 * 数字滚动：从上一个值滚到新值。
 *
 * 为什么要有它：换指标、换口径、换年份时，结论里的数字会变。
 * 直接换掉，用户只看到「啪」地一下；滚过去才知道「从 52 变成 45」——
 * 「各项对比」是动态的这件事，本身就是信息。
 *
 * 两个实现上的讲究：
 *   1. 动画期间**直接改 DOM 文本**，不走 setState。结果列表有 50 多行，
 *      每帧重渲染整棵子树会掉帧；只改一个 span 的 textContent 就没这个问题。
 *   2. 首次渲染不滚（没有「上一个值」），直接给最终值——首屏不该从 0 滚起来。
 *
 * 要不要滚由上层决定（App 会把「系统关了动画 + 用户又手动打开」这种情况也算进去）。
 */
export function CountUp({ value, format = (v) => String(Math.round(v)), duration = 450, animate = true }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  /** 上一次停在哪 */
  const fromRef = useRef(value);
  /** 格式化函数每次渲染都是新引用，存进 ref，免得它把动画 effect 重新触发一遍 */
  const fmtRef = useRef(format);
  fmtRef.current = format;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = fromRef.current;
    const fmt = fmtRef.current;

    if (from === value || !animate) {
      fromRef.current = value;
      el.textContent = fmt(value);
      return;
    }

    // 先把画面拨回起点，避免「最终值闪一下再滚回去」
    el.textContent = fmt(from);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic：起步快、收尾稳
      el.textContent = fmt(from + (value - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
        el.textContent = fmt(value);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // 中途被打断（又切了一次指标），落回最终值，别停在半路
      fromRef.current = value;
      el.textContent = fmt(value);
    };
  }, [value, duration, animate]);

  return (
    <span className="count" ref={ref}>
      {format(value)}
    </span>
  );
}
