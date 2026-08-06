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
): Promise<NotionRegistrationPreview> {
  const dataSource = selectRegistrationDataSource(report);
  validateRegistrationSchema(dataSource);
  const values = mapAnalysisToNotionValues(analysisResult);
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
