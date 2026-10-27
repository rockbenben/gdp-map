import { useState } from 'react';
import { higherLowerPair } from '../lib/play';
import type { HigherItem } from '../lib/play';

interface Props {
  items: HigherItem[];
  metricLabel: string;
  metricShort: (value: number) => string;
  year: number;
  years: number[];
  /** 国家侧最后一年的预测值（2025）；面积不随年份变，调用方会传 undefined */
  forecastYear?: number;
  onYearChange: (year: number) => void;
  yearLocked?: boolean;
  best: number;
  onBest: (best: number) => void;
  onShare: (text: string, message: string) => void;
  onBack: () => void;
}

const kindLabel = (kind: HigherItem['kind']) => (kind === 'country' ? '国家' : '省/州');

/** 两张卡猜谁大：连对计数，最佳存本地 */
export function HigherLower({
  items,
  metricLabel,
  metricShort,
  year,
  years,
  forecastYear,
  onYearChange,
  yearLocked = false,
  best,
  onBest,
  onShare,
  onBack
}: Props) {
  const [pair, setPair] = useState<[HigherItem, HigherItem] | null>(() => higherLowerPair(items));
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);

  const choose = (item: HigherItem) => {
    if (revealed || !pair) return;
    const other = pair[0].id === item.id ? pair[1] : pair[0];
    const win = item.value > other.value;
    setPicked(item.id);
    setRevealed(true);
    if (win) {
      const next = streak + 1;
      setStreak(next);
      if (next > best) onBest(next);
    } else {
      setStreak(0);
    }
  };

  const next = () => {
    setPair(higherLowerPair(items));
    setRevealed(false);
    setPicked(null);
  };

  const restart = () => {
    setStreak(0);
    setPair(higherLowerPair(items));
    setRevealed(false);
    setPicked(null);
  };

  if (!pair) {
    return (
      <section className="play-game">
        <header className="play-game-head">
          <button type="button" className="chip ghost" onClick={onBack}>
            返回玩法
          </button>
          <div>
            <span className="play-kicker">Higher / Lower</span>
            <h2>谁更大？</h2>
          </div>
        </header>
        <p className="play-hint">这个指标下没有足够的两张卡，换一个指标或年份试试。</p>
      </section>
    );
  }

  const [a, b] = pair;
  const winnerId = a.value > b.value ? a.id : b.id;

  return (
    <section className="play-game hl">
      <header className="play-game-head">
        <button type="button" className="chip ghost" onClick={onBack}>
          返回玩法
        </button>
        <div>
          <span className="play-kicker">Higher / Lower</span>
          <h2>谁更大？</h2>
          <p className="play-sub">
            {metricLabel} · {year} 年
          </p>
        </div>
        <label className="hl-year">
          年份
          <select value={year} onChange={(e) => onYearChange(Number(e.target.value))} disabled={yearLocked}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
                {forecastYear != null && y === forecastYear ? '（预测）' : ''}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="hl-meta">
        <span>
          连对 <b>{streak}</b>
        </span>
        <span>
          最佳 <b>{best}</b>
        </span>
        {yearLocked ? <span className="play-hint">这一局还没结束，年份先固定</span> : null}
      </div>

      {forecastYear != null && year === forecastYear ? (
        <p className="play-hint">
          {forecastYear} 年的国家数据是 IMF 的预测值；美国州的数据来自 BEA。
        </p>
      ) : null}

      <div className="hl-cards">
        {[a, b].map((item) => {
          const isPicked = picked === item.id;
          const isWinner = revealed && winnerId === item.id;
          const isLoser = revealed && winnerId !== item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`hl-card${isPicked ? ' picked' : ''}${isWinner ? ' win' : ''}${isLoser ? ' lose' : ''}`}
              onClick={() => choose(item)}
              disabled={revealed}
              aria-pressed={isPicked}
            >
              <span className="hl-kind">
                {kindLabel(item.kind)}
                {item.parentName ? ` · ${item.parentName}` : ''}
              </span>
              <strong className="hl-name">{item.zh}</strong>
              <span className="hl-value">{revealed ? metricShort(item.value) : '?'}</span>
              <span className="hl-hint">{revealed ? (isWinner ? '更大' : '较小') : '点它'}</span>
            </button>
          );
        })}
        <span className="hl-vs" aria-hidden="true">
          VS
        </span>
      </div>

      {revealed ? (
        <div className="play-actions">
          <button type="button" className="primary-btn" onClick={next}>
            下一题
          </button>
          <button type="button" className="chip ghost" onClick={restart}>
            重新开始
          </button>
          <button
            type="button"
            className="chip ghost"
            onClick={() =>
              onShare(
                `我在 GDP 等价地图的 Higher/Lower 连对了 ${streak} 次（最佳 ${best} 次），来试试`,
                '成绩已复制'
              )
            }
          >
            分享成绩
          </button>
        </div>
      ) : (
        <p className="play-hint">点数值更大的那一张。</p>
      )}
    </section>
  );
}
