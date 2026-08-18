import { describe, expect, it } from 'vitest';
import { PUBLIC_REGIONS } from '../src/public-site/geography.ts';
import { renderPublicSourcePage } from '../src/public-site/render.ts';
import { createPublicSourceList } from '../src/public-site/source-list.ts';
import { loadSourceRegistry } from '../src/source-registry/load.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

describe('公開Source一覧', () => {
  it('全Sourceを親自治体単位で地域へ分類し、継続確認中を先に並べる', () => {
    const sourceList = createPublicSourceList(createRegistry());
    const chubu = sourceList.regions.find((region) => region.id === 'chubu');
    const kinki = sourceList.regions.find((region) => region.id === 'kinki');

    expect(sourceList.regions.map((region) => region.name)).toEqual([
      '北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州・沖縄',
    ]);
    expect(chubu?.organizations).toEqual([{
      id: 'nagoya-city',
      name: '名古屋市',
      sources: [
        { name: 'Hatch Technology NAGOYA', url: 'https://example.com/hatch', status: 'active' },
        { name: '提案募集中の課題', url: 'https://example.com/frontier', status: 'active' },
      ],
    }]);
    expect(kinki?.organizations).toEqual([{
      id: 'kyoto-prefecture',
        name: '京都府',
        sources: [
          {
            name: 'デジタル政策・DX推進',
            url: 'https://www.pref.kyoto.jp/digital/',
            status: 'active',
          },
          {
            name: '非公開Source',
            url: 'https://www.pref.kyoto.jp/disabled/',
            status: 'inactive',
          },
        ],
      }]);
    expect(sourceList).toMatchObject({
      organizationCount: 2,
      sourceCount: 4,
      activeSourceCount: 3,
    });
  });

  it('地域、都道府県、その都道府県の組織の順に並べる', () => {
    const sourceList = createPublicSourceList(createGeographicalOrderRegistry());
    const organizationsByRegion = Object.fromEntries(sourceList.regions.map((region) => [
      region.name,
      region.organizations.map((organization) => organization.name),
    ]));

    expect(organizationsByRegion['東北']).toEqual(['青森県', '宮城県', '仙台市']);
    expect(organizationsByRegion['近畿']).toEqual([
      '滋賀県', '京都府', '京都市', '大阪府', '大阪市', '兵庫県', '神戸市',
    ]);
  });

  it('固定8地域に47都道府県を重複なく定義する', () => {
    const prefectures = PUBLIC_REGIONS.flatMap((region) => [...region.prefectures]);

    expect(PUBLIC_REGIONS).toHaveLength(8);
    expect(prefectures).toHaveLength(47);
    expect(new Set(prefectures).size).toBe(47);
  });

  it('公開HTMLには名称・URLだけを載せ、リンクを新しいタブで開く', () => {
    const html = renderPublicSourcePage(createPublicSourceList(createRegistry()));

    expect(html).toContain('<h1>行政情報ソース一覧</h1>');
    expect(html).toContain('<h2 id="organization-index-title">登録自治体</h2>');
    expect(html).toContain('<h2 id="region-hokkaido">北海道</h2>');
    expect(html).toContain('<h2 id="region-kyushu-okinawa">九州・沖縄</h2>');
    expect(html).toContain('data-index-region="shikoku"');
    expect(html).toContain('登録自治体なし');
    expect(html).toContain('href="#organization-nagoya-city"');
    expect(html).toContain('id="organization-nagoya-city"');
    expect(html).toContain('data-source-search');
    expect(html).toContain('src="./search.js"');
    expect(html).toContain('継続確認中 1');
    expect(html).toContain('登録 2');
    expect(html).toContain('class="organization-group"');
    expect(html).not.toContain('organization-card');
    expect(html).not.toContain('organization-grid');
    expect(html).toContain('href="https://example.com/hatch" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('継続確認中');
    expect(html).toContain('現在は未巡回');
    expect(html).toContain('https://www.pref.kyoto.jp/disabled/');
    expect(html).not.toContain('内部メモ');
    expect(html).not.toContain('.article-list a');
    expect(html).not.toContain('high');
    expect(html).not.toContain('disabled-source');
    expect(html).not.toContain('enabled');
  });

  it('HTMLとして解釈される名称とURLをエスケープする', () => {
    const html = renderPublicSourcePage({
      regions: PUBLIC_REGIONS.map((region) => ({
        id: region.id,
        name: region.id === 'kinki' ? '<近畿>' : region.name,
        organizations: region.id === 'kinki' ? [{
          id: 'kyoto-prefecture',
          name: '<京都府>',
          sources: [{ name: 'A & B', url: 'https://example.com/?a=1&b=2', status: 'active' }],
        }] : [],
      })),
      organizationCount: 1,
      sourceCount: 1,
      activeSourceCount: 1,
    });

    expect(html).toContain('&lt;京都府&gt;');
    expect(html).toContain('&lt;近畿&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('https://example.com/?a=1&amp;b=2');
  });

  it('所属都道府県が未設定または未知の組織を名称から推測しない', () => {
    const missingPrefecture = validateSourceRegistry({
      version: 1,
      organizations: [{
        id: 'sendai-city',
        name: '仙台市',
        organization_type: 'designated_city',
        official_domain: 'city.sendai.jp',
        enabled: true,
      }],
      sources: [source({
        id: 'sendai-source',
        organization_id: 'sendai-city',
        name: '公開情報',
        url: 'https://city.sendai.jp/public',
      })],
    });
    const unknownPrefecture = validateSourceRegistry({
      version: 1,
      organizations: [{
        id: 'example-city',
        name: '例市',
        organization_type: 'municipality',
        prefecture: '架空県',
        official_domain: 'example.com',
        enabled: true,
      }],
      sources: [source({
        id: 'example-source',
        organization_id: 'example-city',
        name: '公開情報',
        url: 'https://example.com/public',
      })],
    });

    expect(() => createPublicSourceList(missingPrefecture)).toThrow('has no prefecture');
    expect(() => createPublicSourceList(unknownPrefecture)).toThrow('unknown prefecture');
  });

  it('分類できないルート組織は名称から推測せずbuild対象にしない', () => {
    const registry = validateSourceRegistry({
      version: 1,
      organizations: [{
        id: 'independent-agency',
        name: '○○県共同機構',
        organization_type: 'public_agency',
        official_domain: 'example.com',
        enabled: true,
      }],
      sources: [source({
        id: 'independent-source',
        organization_id: 'independent-agency',
        name: '公開情報',
        url: 'https://example.com/public',
      })],
    });

    expect(() => createPublicSourceList(registry)).toThrow('cannot be classified');
  });

  it('実台帳の全Sourceを名称・URL・公開状態の欠落なく変換する', async () => {
    const registry = await loadSourceRegistry();
    const sourceList = createPublicSourceList(registry);
    const actualSources = sourceList.regions
      .flatMap((region) => region.organizations)
      .flatMap((organization) => organization.sources)
      .toSorted((left, right) => left.url.localeCompare(right.url));
    const expectedSources = registry.sources
      .map((source) => ({
        name: source.name,
        url: source.url,
        status: source.enabled ? 'active' as const : 'inactive' as const,
      }))
      .toSorted((left, right) => left.url.localeCompare(right.url));

    expect(actualSources).toEqual(expectedSources);
    expect(sourceList.sourceCount).toBe(registry.sources.length);
    expect(sourceList.activeSourceCount).toBe(
      registry.sources.filter((source) => source.enabled).length,
    );
  });
});

function createRegistry() {
  return validateSourceRegistry({
    version: 1,
    organizations: [
      {
        id: 'nagoya-city',
        name: '名古屋市',
        organization_type: 'designated_city',
        prefecture: '愛知県',
        official_domain: 'city.nagoya.jp',
        enabled: true,
      },
      {
        id: 'nagoya-external',
        name: '運営事務局',
        organization_type: 'external_organization',
        official_domain: 'example.com',
        enabled: true,
        parent_organization_id: 'nagoya-city',
      },
      {
        id: 'kyoto-prefecture',
        name: '京都府',
        organization_type: 'prefecture',
        prefecture: '京都府',
        official_domain: 'pref.kyoto.jp',
        enabled: true,
      },
    ],
    sources: [
      source({
        id: 'nagoya-frontier',
        organization_id: 'nagoya-city',
        name: '提案募集中の課題',
        url: 'https://example.com/frontier',
      }),
      source({
        id: 'nagoya-hatch',
        organization_id: 'nagoya-external',
        name: 'Hatch Technology NAGOYA',
        url: 'https://example.com/hatch',
      }),
      source({
        id: 'kyoto-digital',
        organization_id: 'kyoto-prefecture',
        name: 'デジタル政策・DX推進',
        url: 'https://www.pref.kyoto.jp/digital/',
      }),
      source({
        id: 'disabled-source',
        organization_id: 'kyoto-prefecture',
        name: '非公開Source',
        url: 'https://www.pref.kyoto.jp/disabled/',
        enabled: false,
      }),
    ],
  });
}

function createGeographicalOrderRegistry() {
  const organizations = [
    organization('sendai-city', '仙台市', 'designated_city', '宮城県'),
    organization('osaka-city', '大阪市', 'designated_city', '大阪府'),
    organization('kyoto-city', '京都市', 'designated_city', '京都府'),
    organization('miyagi-prefecture', '宮城県', 'prefecture', '宮城県'),
    organization('kyoto-prefecture', '京都府', 'prefecture', '京都府'),
    organization('aomori-prefecture', '青森県', 'prefecture', '青森県'),
    organization('shiga-prefecture', '滋賀県', 'prefecture', '滋賀県'),
    organization('osaka-prefecture', '大阪府', 'prefecture', '大阪府'),
    organization('kobe-city', '神戸市', 'designated_city', '兵庫県'),
    organization('hyogo-prefecture', '兵庫県', 'prefecture', '兵庫県'),
  ];

  return validateSourceRegistry({
    version: 1,
    organizations,
    sources: organizations.map((entry, index) => source({
      id: `source-${index + 1}`,
      organization_id: entry.id,
      name: `${entry.name}の情報源`,
      url: `https://${entry.official_domain}/source-${index + 1}`,
    })),
  });
}

function organization(
  id: string,
  name: string,
  organization_type: 'designated_city' | 'prefecture',
  prefecture: string,
) {
  return {
    id,
    name,
    organization_type,
    prefecture,
    official_domain: `${id}.example.com`,
    enabled: true,
  };
}

function source(input: {
  id: string;
  organization_id: string;
  name: string;
  url: string;
  enabled?: boolean;
}) {
  return {
    ...input,
    collector_type: 'list_page',
    source_category: 'proposal',
    priority: 'high',
    enabled: input.enabled ?? true,
    link_selector: '.article-list a',
    notes: '内部メモ',
  };
}
