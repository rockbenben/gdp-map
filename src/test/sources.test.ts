import { describe, expect, it } from 'vitest';
import { dataSourceLine, sourceLabels } from '../lib/sources';

const entity = (
  id: string,
  kind: 'country' | 'region' = 'region',
  parentId: string | null = null
) => ({ id, kind, parentId });

describe('导出图的数据来源', () => {
  it('加州只写 BEA，不把中国年鉴算进去', () => {
    expect(sourceLabels([entity('US-06')])).toEqual(['BEA']);
  });

  it('中国省级写国家统计局', () => {
    expect(sourceLabels([entity('CN-410000')])).toEqual(['国家统计局']);
  });

  it('港澳台走 IMF / 世界银行，不算国家统计局', () => {
    expect(sourceLabels([entity('CN-810000')])).toEqual(['IMF WEO', '世界银行']);
    expect(sourceLabels([entity('CN-820000')])).toEqual(['IMF WEO', '世界银行']);
    expect(sourceLabels([entity('CN-710000')])).toEqual(['IMF WEO', '世界银行']);
  });

  it('国家、州、欧盟区、日本府县混排时按固定顺序去重', () => {
    const labels = sourceLabels([
      entity('US-06'),
      entity('EU-DE9'),
      entity('JP-13'),
      entity('CN-410000'),
      entity('USA', 'country')
    ]);
    expect(labels).toEqual(['IMF WEO', '世界银行', '国家统计局', 'BEA', 'Eurostat', '日本内阁府']);
  });

  it('没有可识别的对象时不编来源', () => {
    expect(dataSourceLine([])).toBe('');
    expect(dataSourceLine([entity('XX-01')])).toBe('');
  });

  it('生成一句可直接放进导出图的来源行', () => {
    expect(dataSourceLine([entity('US-06'), entity('USA', 'country')])).toBe(
      '数据：IMF WEO、世界银行、BEA'
    );
  });
});
