import type { Region } from './types';

/**
 * 导出图里实际用到的数据源。
 *
 * 以前分享卡固定写「IMF + 国家统计局」——选加州时也这么写，
 * 可加州的数据来自 BEA，图里又没有中国省级数据。这里按对象来源拼。
 */
const ORDER = ['IMF WEO', '世界银行', '国家统计局', 'BEA', 'Eurostat', '日本内阁府'];

type Entity = Pick<Region, 'id' | 'kind' | 'parentId'>;

function labelsFor(entity: Entity): string[] {
  if (entity.kind === 'country') return ['IMF WEO', '世界银行'];
  if (entity.id.startsWith('US-')) return ['BEA'];
  if (entity.id.startsWith('EU-')) return ['Eurostat'];
  if (entity.id.startsWith('JP-')) return ['日本内阁府'];
  // 港澳台走省级池，但数据来自 IMF WEO / 世界银行，不是国家统计局
  if (['CN-810000', 'CN-820000', 'CN-710000'].includes(entity.id)) {
    return ['IMF WEO', '世界银行'];
  }
  if (entity.id.startsWith('CN-')) return ['国家统计局'];
  return [];
}

export function sourceLabels(entities: Entity[]): string[] {
  const found = new Set<string>();
  for (const entity of entities) {
    for (const label of labelsFor(entity)) found.add(label);
  }
  return ORDER.filter((label) => found.has(label));
}

export function dataSourceLine(entities: Entity[]): string {
  const labels = sourceLabels(entities);
  return labels.length ? `数据：${labels.join('、')}` : '';
}
