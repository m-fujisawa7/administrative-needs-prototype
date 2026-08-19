import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getEnabledSources,
  getSourcesByOrganization,
  loadSourceRegistry,
} from '../src/source-registry/load.ts';
import { formatSourceList, parseSourceListArgs } from '../src/source-registry/list.ts';
import {
  validateSourceRegistry,
  type SourceRegistry,
} from '../src/source-registry/schema.ts';

const VALID_REGISTRY = {
  version: 1,
  organizations: [{
    id: 'osaka-city',
    name: '大阪市',
    organization_type: 'designated_city',
    official_domain: 'city.osaka.lg.jp',
    enabled: true,
  }],
  sources: [{
    id: 'osaka-source',
    organization_id: 'osaka-city',
    name: '大阪市の情報源',
    url: 'https://www.city.osaka.lg.jp/example',
    collector_type: 'list_page',
    source_category: 'procurement',
    priority: 'high',
    enabled: true,
  }],
} as const;

describe('情報源台帳', () => {
  it('config/sources.yamlの台帳全体が運用上の不変条件を満たす', async () => {
    const registry = await loadSourceRegistry();
    expect(registry.organizations.length).toBeGreaterThan(0);
    expect(registry.sources.length).toBeGreaterThan(0);

    for (const organization of registry.organizations) {
      expect(getSourcesByOrganization(registry, organization.id).length).toBeGreaterThan(0);
    }

    expect(registry.sources.every((source) =>
      [...new URL(source.url).searchParams.keys()].every((key) => !key.startsWith('utm_')),
    )).toBe(true);
  });

  it('別ファイルの正常なYAMLを読み込める', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'source-registry-'));
    const filePath = join(directory, 'sources.yaml');
    await writeFile(filePath, [
      'version: 1',
      'organizations:',
      '  - id: osaka-city',
      '    name: 大阪市',
      '    organization_type: designated_city',
      '    official_domain: city.osaka.lg.jp',
      '    enabled: true',
      'sources: []',
      '',
    ].join('\n'));
    await expect(loadSourceRegistry(filePath)).resolves.toMatchObject({ version: 1 });
  });

  it.each([
    ['組織ID重複', (registry: MutableRegistry) => registry.organizations.push({ ...registry.organizations[0]! }), '組織ID'],
    ['情報源ID重複', (registry: MutableRegistry) => registry.sources.push({ ...registry.sources[0]!, url: 'https://www.city.osaka.lg.jp/other' }), '情報源ID'],
    ['URL重複', (registry: MutableRegistry) => registry.sources.push({ ...registry.sources[0]!, id: 'another-source' }), '情報源URL'],
    ['存在しない組織参照', (registry: MutableRegistry) => { registry.sources[0]!.organization_id = 'missing-city'; }, '定義されていません'],
    ['不正なURL', (registry: MutableRegistry) => { registry.sources[0]!.url = 'ftp://example.com/file'; }, 'http または https'],
    ['不正なcollector_type', (registry: MutableRegistry) => { registry.sources[0]!.collector_type = 'crawler'; }, 'Invalid option'],
  ])('%sを検出できる', (_label, mutate, expectedMessage) => {
    const input = mutableRegistry();
    mutate(input);
    expect(() => validateSourceRegistry(input)).toThrow(expectedMessage);
  });

  it('無効な組織の情報源は enabled=true でも有効一覧から除外する', () => {
    const registry = validateSourceRegistry({
      ...mutableRegistry(),
      organizations: [{ ...mutableRegistry().organizations[0]!, enabled: false }],
    });
    expect(getEnabledSources(registry)).toEqual([]);
  });
});

describe('一覧CLI', () => {
  it('オプションを解釈して一覧を絞り込める', () => {
    const filters = parseSourceListArgs(['--enabled', '--organization', 'osaka-city', '--priority=high']);
    const output = formatSourceList(validateSourceRegistry(mutableRegistry()), filters);
    expect(output).toContain('大阪市 (osaka-city)');
    expect(output).toContain('[high] [list_page] [有効] 大阪市の情報源');
  });

  it('不正なpriorityを拒否する', () => {
    expect(() => parseSourceListArgs(['--priority', 'urgent'])).toThrow('priority は');
  });
});

type MutableRegistry = {
  version: number;
  organizations: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
};

function mutableRegistry(): MutableRegistry {
  return structuredClone(VALID_REGISTRY) as unknown as MutableRegistry;
}

// 公開型が意図どおり推論できることを型検査にも含める。
const _typeCheck: SourceRegistry | undefined = undefined;
void _typeCheck;

describe('initial_sinceの検証', () => {
  it('YYYY-MM-DD形式のinitial_sinceを受理する', () => {
    const registry = validateSourceRegistry(registryWithInitialSince('2026-08-01'));
    expect(registry.sources[0]?.initial_since).toBe('2026-08-01');
  });

  it('initial_since未指定を従来どおり受理する', () => {
    const registry = validateSourceRegistry(registryWithInitialSince(undefined));
    expect(registry.sources[0]?.initial_since).toBeUndefined();
  });

  it.each(['2026/08/01', '2026-02-30', '20260801', '2026-13-01', ''])(
    '不正なinitial_since %s を拒否する',
    (value) => {
      expect(() => validateSourceRegistry(registryWithInitialSince(value))).toThrow();
    },
  );
});

function registryWithInitialSince(initialSince: string | undefined): unknown {
  return {
    version: 1,
    organizations: [{
      id: 'osaka-city',
      name: '大阪市',
      organization_type: 'designated_city',
      official_domain: 'city.osaka.lg.jp',
      enabled: true,
    }],
    sources: [{
      id: 'osaka-digital-rss',
      organization_id: 'osaka-city',
      name: 'デジタル統括室 RSS',
      url: 'https://www.city.osaka.lg.jp/rss.xml',
      collector_type: 'rss',
      source_category: 'digital_news',
      priority: 'high',
      enabled: true,
      ...(initialSince === undefined ? {} : { initial_since: initialSince }),
    }],
  };
}

describe('allow_empty_candidatesの検証', () => {
  it('真偽値を受理し、未指定はundefinedのままにする', () => {
    expect(validateSourceRegistry(registryWithAllowEmpty(true)).sources[0]?.allow_empty_candidates)
      .toBe(true);
    expect(validateSourceRegistry(registryWithAllowEmpty(false)).sources[0]?.allow_empty_candidates)
      .toBe(false);
    expect(
      validateSourceRegistry(registryWithAllowEmpty(undefined)).sources[0]?.allow_empty_candidates,
    ).toBeUndefined();
  });

  it.each(['true', 1, null, 'yes'])('真偽値以外の %s を拒否する', (value) => {
    expect(() => validateSourceRegistry(registryWithAllowEmpty(value))).toThrow();
  });

  it('実台帳で設定した情報源が検証を通り、募集中だけを載せる一覧に付いている', async () => {
    const { loadSourceRegistry } = await import('../src/source-registry/index.ts');
    const registry = await loadSourceRegistry();
    const configured = registry.sources
      .filter((source) => source.allow_empty_candidates === true)
      .map((source) => source.id)
      .sort();
    // いずれも募集中・実施中・新着のものだけを載せる一覧で、0件になる期間が正常状態。
    expect(configured).toEqual([
      'aichi-digital-strategy',
      'aichi-toshi-somu',
      'fukui-dx-kobo',
      'fukuoka-ppp-pfi',
      'gifu-digital-strategy',
      'gifu-industry-innovation',
      'gifu-proposal-list',
      'hyogo-service-procurement',
      'kawasaki-sounding',
      'kobe-rfi-rfc',
      'kobe-sounding',
      'sapporo-smartcity-procurement',
      'sendai-cross-lab-partnership',
      'sendai-smart-frontier',
      'shizuoka-kikaku-procurement',
      'yamanashi-dx-news',
    ]);
    // 一覧ページ解析だけが読み取る設定なので、他のcollector_typeへは付けない。
    for (const source of registry.sources) {
      if (source.allow_empty_candidates === undefined) continue;
      expect(source.collector_type).toBe('list_page');
      expect(source.link_selector).toBeDefined();
    }
  });
});

function registryWithAllowEmpty(allowEmpty: unknown): unknown {
  return {
    version: 1,
    organizations: [{
      id: 'kobe-city',
      name: '神戸市',
      organization_type: 'designated_city',
      official_domain: 'city.kobe.lg.jp',
      enabled: true,
    }],
    sources: [{
      id: 'kobe-rfi-rfc',
      organization_id: 'kobe-city',
      name: 'RFI・RFC',
      url: 'https://www.city.kobe.lg.jp/rfi.html',
      collector_type: 'list_page',
      source_category: 'rfi',
      priority: 'high',
      enabled: true,
      link_selector: '#tmp_contents a',
      ...(allowEmpty === undefined ? {} : { allow_empty_candidates: allowEmpty }),
    }],
  };
}

describe('list_pageのtitle_excludes設定', () => {
  it('kitakyushu-dx-divisionの実台帳がtitle_excludesを持ち検証を通る', async () => {
    const { loadSourceRegistry } = await import('../src/source-registry/index.ts');
    const registry = await loadSourceRegistry();
    const source = registry.sources.find(({ id }) => id === 'kitakyushu-dx-division');

    expect(source?.collector_type).toBe('list_page');
    expect(source?.title_excludes).toEqual([
      'よくある質問',
      'FAQ',
      '使い方',
      'セキュリティポリシー',
    ]);
  });

  it('結果公表やプロポーザルを除外条件に入れていない', async () => {
    const { loadSourceRegistry } = await import('../src/source-registry/index.ts');
    const registry = await loadSourceRegistry();
    const source = registry.sources.find(({ id }) => id === 'kitakyushu-dx-division');

    for (const keyword of ['結果公表', 'プロポーザル', '公募', '募集', 'RFI']) {
      expect(source?.title_excludes ?? []).not.toContain(keyword);
    }
  });
});
