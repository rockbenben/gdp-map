export interface RankRow {
  id: string;
  label: string;
  value: string;
  rank: number;
  total: number;
  isCurrent: boolean;
}

interface Props {
  /** 参照物的名字 */
  name: string;
  rows: RankRow[];
  /** 参照物本来就是国家：不要再问「假如它是一个国家」 */
  isCountry?: boolean;
}

/**
 * 排名卡：省/州问「假如它是一个国家」，国家侧直接给世界名次。
 * 这是整个工具最有传播力的说法：GDP 排第几、面积排第几、人口排第几。
 */
export function CounterfactualCard({ name, rows, isCountry = false }: Props) {
  return (
    <section className="counterfactual">
      <h3>
        {isCountry ? (
          <>
            <strong>{name}</strong> 的世界名次
          </>
        ) : (
          <>
            假如 <strong>{name}</strong> 是一个国家
          </>
        )}
      </h3>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className={r.isCurrent ? 'current' : ''}>
            <span className="cf-label">{r.label}</span>
            <span className="cf-value">{r.value}</span>
            <span className="cf-rank">
              第 <b>{r.rank}</b> 位
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
