import { describe, expect, it } from 'vitest';
import { renderPublicSourcePage } from '../src/public-site/render.ts';
import { createPublicSourceList } from '../src/public-site/source-list.ts';
import { loadSourceRegistry } from '../src/source-registry/load.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

describe('公開Source一覧', () => {
  it('全Sourceを親自治体単位で分類し、継続確認中を先に並べる', () => {
    const sourceList = createPublicSourceList(createRegistry());

    expect(sourceList).toEqual({
      prefectures: [{
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
      }],
      municipalities: [{
        name: '名古屋市',
        sources: [
          { name: 'Hatch Technology NAGOYA', url: 'https://example.com/hatch', status: 'active' },
          { name: '提案募集中の課題', url: 'https://example.com/frontier', status: 'active' },
        ],
      }],
      organizationCount: 2,
      sourceCount: 4,
      activeSourceCount: 3,
    });
  });

  it('公開HTMLには名称・URLだけを載せ、リンクを新しいタブで開く', () => {
    const html = renderPublicSourcePage(createPublicSourceList(createRegistry()));

    expect(html).toContain('<h1>行政情報ソース一覧</h1>');
    expect(html).toContain('<h2 id="都道府県">都道府県</h2>');
    expect(html).toContain('<h2 id="市区町村">市区町村</h2>');
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
      prefectures: [{
        name: '<京都府>',
        sources: [{ name: 'A & B', url: 'https://example.com/?a=1&b=2', status: 'active' }],
      }],
      municipalities: [],
      organizationCount: 1,
      sourceCount: 1,
      activeSourceCount: 1,
    });

    expect(html).toContain('&lt;京都府&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('https://example.com/?a=1&amp;b=2');
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
    const actualSources = [...sourceList.prefectures, ...sourceList.municipalities]
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
