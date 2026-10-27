import { useState } from 'react';
import { blindRound } from '../lib/play';
import type { BlindItem, BlindRound } from '../lib/play';
import type { GeoFeature } from '../lib/types';
import { ShapeSilhouette } from './ShapeSilhouette';

interface Props {
  items: BlindItem[];
  features: Map<string, GeoFeature>;
  best: number;
  onBest: (best: number) => void;
  onShare: (text: string, message: string) => void;
  onBack: () => void;
}

const ROUNDS = 10;
const kindText = (kind: BlindItem['kind']) => (kind === 'country' ? '国家' : '省/州');

/** 看剪影四选一，10 题一轮 */
export function BlindGuess({ items, features, best, onBest, onShare, onBack }: Props) {
  const [round, setRound] = useState(0);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<'guess' | 'done'>('guess');
  const [data, setData] = useState<BlindRound | null>(() => blindRound(items));
  const [chosen, setChosen] = useState<string | null>(null);

  const answer = data?.answer ?? null;
  const feature = answer ? features.get(answer.geoId) : undefined;
  const revealed = chosen != null;

  const choose = (id: string) => {
    if (!answer || revealed) return;
    setChosen(id);
    if (id === answer.id) setScore((s) => s + 1);
  };

  const next = () => {
    if (!answer) return;
    if (round + 1 >= ROUNDS) {
      setPhase('done');
      if (score > best) onBest(score);
      return;
    }
    setRound((r) => r + 1);
    setChosen(null);
    setData(blindRound(items));
  };

  const restart = () => {
    setRound(0);
    setScore(0);
    setPhase('guess');
    setChosen(null);
    setData(blindRound(items));
  };

  const share = () =>
    onShare(
      `我在 GDP 等价地图盲猜轮廓，10 题猜对 ${score} 个（最佳 ${best} 个），来试试`,
      '成绩已复制'
    );

  if (!answer && phase === 'guess') {
    return (
      <section className="play-game">
        <header className="play-game-head">
          <button type="button" className="chip ghost" onClick={onBack}>
            返回玩法
          </button>
          <div>
            <span className="play-kicker">盲猜轮廓</span>
            <h2>看形状猜地方</h2>
          </div>
        </header>
        <p className="play-hint">轮廓数据还没准备好，稍后再试。</p>
      </section>
    );
  }

  if (phase === 'done') {
    return (
      <section className="play-game blind">
        <header className="play-game-head">
          <button type="button" className="chip ghost" onClick={onBack}>
            返回玩法
          </button>
          <div>
            <span className="play-kicker">盲猜轮廓</span>
            <h2>这一轮猜对了 {score}/10</h2>
            <p className="play-sub">最佳 {Math.max(best, score)}/10</p>
          </div>
        </header>
        <div className="play-actions">
          <button type="button" className="primary-btn" onClick={restart}>
            再来一轮
          </button>
          <button type="button" className="chip ghost" onClick={share}>
            分享成绩
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="play-game blind">
      <header className="play-game-head">
        <button type="button" className="chip ghost" onClick={onBack}>
          返回玩法
        </button>
        <div>
          <span className="play-kicker">盲猜轮廓</span>
          <h2>这是哪个{kindText(answer!.kind)}？</h2>
          <p className="play-sub">
            第 {round + 1}/{ROUNDS} 题 · 已猜对 {score} 个
          </p>
        </div>
      </header>

      <div className="blind-shape">
        {feature ? <ShapeSilhouette feature={feature} /> : <p className="play-hint">轮廓加载中…</p>}
      </div>

      <div className="blind-options">
        {data!.options.map((option) => {
          const isAnswer = revealed && option.id === answer!.id;
          const isWrong = revealed && option.id === chosen && option.id !== answer!.id;
          return (
            <button
              key={option.id}
              type="button"
              className={`blind-option${isAnswer ? ' correct' : ''}${isWrong ? ' wrong' : ''}`}
              onClick={() => choose(option.id)}
              disabled={revealed}
            >
              {option.zh}
            </button>
          );
        })}
      </div>

      {revealed ? (
        <div className="play-actions">
          <p className={`blind-result${chosen === answer!.id ? ' ok' : ''}`}>
            {chosen === answer!.id ? '答对了' : `答错了，答案是 ${answer!.zh}`}
          </p>
          <button type="button" className="primary-btn" onClick={next}>
            {round + 1 >= ROUNDS ? '看结果' : '下一题'}
          </button>
        </div>
      ) : (
        <p className="play-hint">看轮廓，从四个名字里选一个。</p>
      )}
    </section>
  );
}
