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
  it('config/sources.yamlから大阪市・名古屋市・石川県の情報源を読み込む', async () => {
    const registry = await loadSourceRegistry();
    expect(registry.organizations).toHaveLength(4);
    expect(getSourcesByOrganization(registry, 'osaka-city')).toHaveLength(7);
    expect(getSourcesByOrganization(registry, 'nagoya-city')).toHaveLength(2);
    expect(getSourcesByOrganization(registry, 'nagoya-city-hatch-tech')).toHaveLength(1);
    expect(getSourcesByOrganization(registry, 'ishikawa-prefecture')).toHaveLength(4);
    expect(getEnabledSources(registry)).toHaveLength(12);
    expect(registry.sources.every((source) => !source.url.includes('utm_'))).toBe(true);
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
