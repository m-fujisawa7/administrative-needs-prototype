import { describe, expect, it } from 'vitest';
import { getTrustedAttachmentDomains } from '../src/source-registry/domains.ts';
import type { Organization } from '../src/source-registry/schema.ts';
import { isHostnameAllowed } from '../src/source-check/fetch.ts';

function organization(
  id: string,
  officialDomain: string,
  parentId?: string,
): Organization {
  return {
    id,
    name: id,
    organization_type: parentId === undefined ? 'designated_city' : 'external_organization',
    official_domain: officialDomain,
    enabled: true,
    ...(parentId === undefined ? {} : { parent_organization_id: parentId }),
  };
}

const NAGOYA_CITY = organization('nagoya-city', 'city.nagoya.jp');
const HATCH = organization('nagoya-city-hatch-tech', 'hatch-tech-nagoya.jp', 'nagoya-city');
const OSAKA_CITY = organization('osaka-city', 'city.osaka.lg.jp');

const NAGOYA_REGISTRY = { organizations: [NAGOYA_CITY, HATCH, OSAKA_CITY] };

describe('getTrustedAttachmentDomains', () => {
  it('親組織の official_domain を返す', () => {
    expect(getTrustedAttachmentDomains(NAGOYA_REGISTRY, HATCH)).toEqual(['city.nagoya.jp']);
  });

  it('親を持たない組織では空配列を返す（既存の挙動を維持する）', () => {
    expect(getTrustedAttachmentDomains(NAGOYA_REGISTRY, NAGOYA_CITY)).toEqual([]);
    expect(getTrustedAttachmentDomains(NAGOYA_REGISTRY, OSAKA_CITY)).toEqual([]);
  });

  it('組織自身の official_domain は含めない（呼び出し側が既に許可しているため）', () => {
    expect(getTrustedAttachmentDomains(NAGOYA_REGISTRY, HATCH))
      .not.toContain('hatch-tech-nagoya.jp');
  });

  it('祖先まで辿る', () => {
    const grandparent = organization('pref', 'pref.aichi.lg.jp');
    const parent = organization('city', 'city.nagoya.jp', 'pref');
    const child = organization('gaikaku', 'gaikaku.example.jp', 'city');
    const registry = { organizations: [grandparent, parent, child] };
    expect(getTrustedAttachmentDomains(registry, child))
      .toEqual(['city.nagoya.jp', 'pref.aichi.lg.jp']);
  });

  it('親が見つからない場合は空配列を返す', () => {
    const orphan = organization('orphan', 'orphan.example.jp', 'missing-parent');
    expect(getTrustedAttachmentDomains({ organizations: [orphan] }, orphan)).toEqual([]);
  });

  it('循環参照があっても無限ループしない', () => {
    const a = organization('a', 'a.example.jp', 'b');
    const b = organization('b', 'b.example.jp', 'a');
    const registry = { organizations: [a, b] };
    expect(getTrustedAttachmentDomains(registry, a)).toEqual(['b.example.jp']);
  });

  it('自分自身を親に指定していても無限ループしない', () => {
    const self = organization('self', 'self.example.jp', 'self');
    expect(getTrustedAttachmentDomains({ organizations: [self] }, self)).toEqual([]);
  });

  it('親が組織自身と同じドメインなら重複させない', () => {
    const parent = organization('parent', 'city.nagoya.jp');
    const child = organization('child', 'city.nagoya.jp', 'parent');
    expect(getTrustedAttachmentDomains({ organizations: [parent, child] }, child)).toEqual([]);
  });
});

describe('isHostnameAllowed: 複数ドメイン', () => {
  const allowed = ['hatch-tech-nagoya.jp', 'city.nagoya.jp'];

  it('情報源本体のドメインを許可する', () => {
    expect(isHostnameAllowed('www.hatch-tech-nagoya.jp', allowed)).toBe(true);
    expect(isHostnameAllowed('hatch-tech-nagoya.jp', allowed)).toBe(true);
  });

  it('親組織のドメインとそのサブドメインを許可する', () => {
    expect(isHostnameAllowed('city.nagoya.jp', allowed)).toBe(true);
    expect(isHostnameAllowed('www.city.nagoya.jp', allowed)).toBe(true);
    expect(isHostnameAllowed('www.water.city.nagoya.jp', allowed)).toBe(true);
  });

  it('無関係な外部ドメインを拒否する', () => {
    expect(isHostnameAllowed('example.com', allowed)).toBe(false);
    expect(isHostnameAllowed('www.example.com', allowed)).toBe(false);
  });

  it('接尾辞が一致するだけのドメインを拒否する', () => {
    expect(isHostnameAllowed('evil-city.nagoya.jp', allowed)).toBe(false);
    expect(isHostnameAllowed('evilcity.nagoya.jp', allowed)).toBe(false);
    expect(isHostnameAllowed('nagoya.jp', allowed)).toBe(false);
    expect(isHostnameAllowed('city.nagoya.jp.example.com', allowed)).toBe(false);
  });

  it('前方一致だけのドメインを拒否する', () => {
    expect(isHostnameAllowed('city.nagoya.jp.evil.com', allowed)).toBe(false);
    expect(isHostnameAllowed('hatch-tech-nagoya.jp.evil.com', allowed)).toBe(false);
  });

  it('空配列はすべて拒否する', () => {
    expect(isHostnameAllowed('city.nagoya.jp', [])).toBe(false);
  });

  it('文字列を1件渡した場合は従来どおり判定する', () => {
    expect(isHostnameAllowed('www.city.osaka.lg.jp', 'city.osaka.lg.jp')).toBe(true);
    expect(isHostnameAllowed('www.city.nagoya.jp', 'hatch-tech-nagoya.jp')).toBe(false);
  });

  it('大文字と末尾ドットを正規化して判定する', () => {
    expect(isHostnameAllowed('WWW.City.Nagoya.JP.', allowed)).toBe(true);
  });
});
