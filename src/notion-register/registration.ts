import { z } from 'zod';
import type { AiCheckResult } from '../ai/types.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../notion-check/types.ts';
import { mapNotionRegistrationApiError, NotionRegistrationError } from './errors.ts';
import { buildNotionPageProperties, mapAnalysisToNotionValues } from './mapping.ts';
import {
  findMissingNotionOptions,
  selectRegistrationDataSource,
  validateRegistrationSchema,
} from './schema.ts';
import type {
  CreatedNotionPage,
  ExistingNotionPage,
  NotionRegistrationPreview,
} from './types.ts';

const queryResponseSchema = z.looseObject({
  object: z.literal('list'),
  results: z.array(z.looseObject({
    object: z.literal('page'),
    id: z.string().min(1),
    url: z.url(),
  })),
});

const createdPageSchema = z.looseObject({
  object: z.literal('page'),
  id: z.string().min(1),
  url: z.url(),
});

export async function prepareNotionRegistration(
  client: NotionRegistrationClient,
  report: NotionConnectionReport,
  analysisResult: AiCheckResult,
  write: boolean,
  notionOrganizationName?: string,
): Promise<NotionRegistrationPreview> {
  const dataSource = selectRegistrationDataSource(report);
  validateRegistrationSchema(dataSource);
  const mappedValues = mapAnalysisToNotionValues(analysisResult);
  // AI入力・解析結果では実際の発信主体を保持し、Notionの「自治体」表示だけを
  // Source固有設定で明示的に上書きする。未設定Sourceは従来値をそのまま使う。
  const values = notionOrganizationName === undefined
    ? mappedValues
    : { ...mappedValues, organizationName: notionOrganizationName };
  const properties = buildNotionPageProperties(values);
  const duplicate = await findExistingNotionPage(
    client,
    dataSource.id,
    values.officialUrl,
  );
  return {
    databaseName: report.databaseName,
    dataSource,
    sourceId: analysisResult.sourceId,
    analysisResult,
    values,
    properties,
    duplicate,
    missingOptions: findMissingNotionOptions(dataSource, values),
    write,
  };
}

const HTTP_PREFIX = 'http://';

/**
 * 事前の重複確認。完全一致で見つからず、URLが `http://` の場合だけ
 * scheme を `https://` へ替えてもう1度だけ照合する。
 *
 * 一覧ページが `http://` のリンクを張り、サーバが `https://` へリダイレクトする
 * 情報源がある。この場合、候補URL（http）ではNotionの登録済みページに一致せず、
 * AI判定後の最終URL（https）を使う登録直前の確認で初めて重複と分かるため、
 * HTML取得・PDF抽出・Claude解析と `--limit` の枠を無駄に消費していた。
 * 実測では長野県の公募公告一覧が該当し、候補354件のうち11件が `http://` だった。
 *
 * **置き換えるのは scheme だけで、host・port・path・query・fragment は変更しない。**
 * `https://` から `http://` への逆方向も行わない。実測できた差だけを吸収する。
 * 候補URLは `new URL().href` 経由で作られ scheme が小文字に正規化されるため、
 * 前方一致で判定して差し支えない。
 */
export async function findExistingNotionPageWithHttpsFallback(
  client: NotionRegistrationClient,
  dataSourceId: string,
  officialUrl: string,
): Promise<ExistingNotionPage | null> {
  const exact = await findExistingNotionPage(client, dataSourceId, officialUrl);
  if (exact !== null) return exact;
  if (!officialUrl.startsWith(HTTP_PREFIX)) return null;
  const httpsUrl = `https://${officialUrl.slice(HTTP_PREFIX.length)}`;
  return findExistingNotionPage(client, dataSourceId, httpsUrl);
}

export async function findExistingNotionPage(
  client: NotionRegistrationClient,
  dataSourceId: string,
  officialUrl: string,
): Promise<ExistingNotionPage | null> {
  let rawResponse: unknown;
  try {
    rawResponse = await client.queryDataSourceByUrl(
      dataSourceId,
      '公式URL',
      officialUrl,
    );
  } catch (error) {
    throw mapNotionRegistrationApiError(error, 'query');
  }
  const response = queryResponseSchema.safeParse(rawResponse);
  if (!response.success) {
    throw new NotionRegistrationError(
      'The Notion data source query response was incomplete.',
    );
  }
  const page = response.data.results[0];
  return page === undefined ? null : { id: page.id, url: page.url };
}

export async function createNotionRegistrationPage(
  client: NotionRegistrationClient,
  preview: NotionRegistrationPreview,
): Promise<CreatedNotionPage> {
  if (preview.duplicate !== null) {
    throw new NotionRegistrationError(
      'A page with the same official URL already exists.',
    );
  }
  if (preview.missingOptions.length > 0) {
    throw new NotionRegistrationError(
      'Notion registration was blocked because creating missing select options would change the data source schema.',
    );
  }

  let rawPage: unknown;
  try {
    rawPage = await client.createPage(preview.dataSource.id, preview.properties);
  } catch (error) {
    throw mapNotionRegistrationApiError(error, 'create');
  }
  const page = createdPageSchema.safeParse(rawPage);
  if (!page.success) {
    throw new NotionRegistrationError('The created Notion page response was incomplete.');
  }
  return { id: page.data.id, url: page.data.url };
}
