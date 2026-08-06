import { describe, expect, it } from 'vitest';
import { checkNotionConnection } from '../src/notion-check/check.ts';
import { mapNotionApiError } from '../src/notion-check/errors.ts';
import { formatNotionConnectionReport } from '../src/notion-check/format.ts';
import {
  extractNotionDatabaseId,
  normalizeNotionDatabaseId,
} from '../src/notion-check/id.ts';
import type { NotionReadClient } from '../src/notion-check/types.ts';
import {
  parseNotionCheckArgs,
  runNotionCheck,
} from '../src/commands/notion-check.ts';

const COMPACT_DATABASE_ID = '0123456789abcdef0123456789abcdef';
const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const DATA_SOURCE_ID = '11111111-2222-3333-4444-555555555555';
const SECOND_DATA_SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Notion ID解析', () => {
  it('Notion URLから32文字IDを取得できる', () => {
    expect(extractNotionDatabaseId(
      `https://www.notion.so/workspace/Administrative-needs-${COMPACT_DATABASE_ID}`,
    )).toBe(DATABASE_ID);
  });

  it('UUID形式のIDを受け取れる', () => {
    expect(normalizeNotionDatabaseId(DATABASE_ID.toUpperCase())).toBe(DATABASE_ID);
    expect(parseNotionCheckArgs(['--database-id', DATABASE_ID])).toEqual({
      databaseId: DATABASE_ID,
    });
  });

  it('クエリパラメータ付きURLではパスのIDだけを使用する', () => {
    expect(extractNotionDatabaseId(
      `https://app.notion.com/p/${COMPACT_DATABASE_ID}?v=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&source=copy_link`,
    )).toBe(DATABASE_ID);
    expect(() => extractNotionDatabaseId(
      `https://app.notion.com/p/not-a-database?v=${COMPACT_DATABASE_ID}`,
    )).toThrow('Could not extract');
  });

  it('不正URLとNotion以外のホストを拒否する', () => {
    expect(() => extractNotionDatabaseId('not-a-url')).toThrow('Could not extract');
    expect(() => extractNotionDatabaseId(
      `https://example.com/${COMPACT_DATABASE_ID}`,
    )).toThrow('Could not extract');
  });

  it('URLとIDの同時指定、未指定、重複指定を拒否する', () => {
    expect(() => parseNotionCheckArgs([
      '--database-url', `https://notion.so/${COMPACT_DATABASE_ID}`,
      '--database-id', DATABASE_ID,
    ])).toThrow('not both');
    expect(() => parseNotionCheckArgs([])).toThrow(
      'Specify either --database-url or --database-id.',
    );
    expect(() => parseNotionCheckArgs([
      '--database-id', DATABASE_ID,
      '--database-id', DATABASE_ID,
    ])).toThrow('only be specified once');
  });
});

describe('Notion読み取り確認', () => {
  it('データベース名、データソース、プロパティ名・ID・種類を処理できる', async () => {
    const report = await checkNotionConnection(client(), DATABASE_ID);
    expect(report).toEqual({
      databaseName: '行政ニーズ',
      databaseId: DATABASE_ID,
      dataSources: [{
        name: '行政ニーズ',
        id: DATA_SOURCE_ID,
        properties: [
          { name: '案件名', id: 'title', type: 'title', options: [] },
          { name: '公式URL', id: 'url-id', type: 'url', options: [] },
        ],
      }],
    });

    const formatted = formatNotionConnectionReport(report);
    expect(formatted).toContain('Name: 行政ニーズ');
    expect(formatted).toContain(`ID: ${DATA_SOURCE_ID}`);
    expect(formatted).toContain('- 案件名 (ID: title): title');
    expect(formatted).toContain('No data was written.');
  });

  it('複数データソースをすべて処理し、自動選択しない', async () => {
    const report = await checkNotionConnection(client({ multiple: true }), DATABASE_ID);
    expect(report.dataSources.map((dataSource) => dataSource.id)).toEqual([
      DATA_SOURCE_ID,
      SECOND_DATA_SOURCE_ID,
    ]);
    const formatted = formatNotionConnectionReport(report);
    expect(formatted).toContain('Data sources: 2');
    expect(formatted).toContain('Warning: Multiple data sources were found.');
    expect(formatted).toContain('Select a data source before implementing page creation.');
    expect(formatted).not.toContain('Registration candidate data source ID');
  });

  it('データソース0件をエラーにする', async () => {
    await expect(checkNotionConnection(client({ empty: true }), DATABASE_ID))
      .rejects.toThrow('No data sources were found in the database.');
  });

  it.each([
    [401, 'unauthorized', 'Notion authentication failed.'],
    [403, 'restricted_resource', 'does not have permission'],
    [404, 'object_not_found', 'database was not found'],
  ])('Notion APIの%sを安全なメッセージへ変換する', (status, code, message) => {
    expect(mapNotionApiError({ status, code, message: 'unsafe API detail' }).message)
      .toContain(message);
  });

  it('API制限・一時障害はHTTPステータスとAPIコードだけを表示する', () => {
    const error = mapNotionApiError({
      status: 429,
      code: 'rate_limited',
      message: 'unsafe API detail',
    });
    expect(error.message).toBe(
      'Notion API request failed. HTTP status: 429. Code: rate_limited.',
    );
    expect(error.message).not.toContain('unsafe API detail');
  });
});

describe('notion:checkコマンド', () => {
  it('トークン未設定を判別する', async () => {
    const stderr: string[] = [];
    const exitCode = await runNotionCheck(['--database-id', DATABASE_ID], {
      env: {},
      loadEnvironment: () => undefined,
      stderr: (message) => stderr.push(message),
    });
    expect(exitCode).toBe(2);
    expect(stderr).toEqual(['NOTION_TOKEN is not set in .env.']);
  });

  it('エラーやログにトークンを含めない', async () => {
    const token = 'secret-test-token-value';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runNotionCheck(['--database-id', DATABASE_ID], {
      env: { NOTION_TOKEN: token },
      loadEnvironment: () => undefined,
      createClient: () => ({
        retrieveDatabase: async () => {
          throw {
            status: 500,
            code: 'internal_server_error',
            message: `unsafe ${token}`,
          };
        },
        retrieveDataSource: async () => {
          throw new Error('not called');
        },
      }),
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    expect(exitCode).toBe(1);
    expect([...stdout, ...stderr].join('\n')).not.toContain(token);
    expect(stderr.join('\n')).toContain('HTTP status: 500');
    expect(stderr.join('\n')).toContain('Code: internal_server_error');
  });

  it('モッククライアントで成功結果を表示し、書き込みAPIを必要としない', async () => {
    const stdout: string[] = [];
    const exitCode = await runNotionCheck(['--database-id', DATABASE_ID], {
      env: { NOTION_TOKEN: 'test-token' },
      loadEnvironment: () => undefined,
      createClient: () => client(),
      stdout: (message) => stdout.push(message),
    });
    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Connection successful.');
    expect(stdout.join('\n')).toContain('Registration candidate data source ID');
  });
});

function client(options: { multiple?: boolean; empty?: boolean } = {}): NotionReadClient {
  const references = options.empty
    ? []
    : [
        { id: DATA_SOURCE_ID, name: '行政ニーズ' },
        ...(options.multiple
          ? [{ id: SECOND_DATA_SOURCE_ID, name: '補助台帳' }]
          : []),
      ];
  return {
    retrieveDatabase: async () => ({
      object: 'database',
      id: DATABASE_ID,
      title: [{ plain_text: '行政ニーズ' }],
      data_sources: references,
    }),
    retrieveDataSource: async (dataSourceId) => ({
      object: 'data_source',
      id: dataSourceId,
      title: [{ plain_text: dataSourceId === DATA_SOURCE_ID ? '行政ニーズ' : '補助台帳' }],
      properties: {
        案件名: { id: 'title', name: '案件名', type: 'title' },
        公式URL: { id: 'url-id', name: '公式URL', type: 'url' },
      },
    }),
  };
}
