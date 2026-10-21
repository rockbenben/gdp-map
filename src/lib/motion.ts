import { useEffect, useState } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * 系统是不是开着「减少动态效果」。
 *
 * Windows 的「设置 → 辅助功能 → 视觉效果 → 动画效果」关掉之后，
 * Chromium 就会报 `prefers-reduced-motion: reduce`。
 *
 * ⚠️ 这是**默认值，不是命令**：用户可能在页面上手动把动效打开
 * （见 App.tsx 的 motionOverride），所以这里只报系统的偏好。
 */
export function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(REDUCED).matches : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(REDUCED);
    const onChange = () => setReduced(mq.matches);
    // 用户在系统设置里改了，这里要跟着变
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
