import { z } from 'zod';
import { mapNotionApiError, NotionCheckError } from './errors.ts';
import type {
  NotionConnectionReport,
  NotionDataSourceInfo,
  NotionReadClient,
} from './types.ts';

const richTextSchema = z.looseObject({
  plain_text: z.string(),
});

const databaseSchema = z.looseObject({
  object: z.literal('database'),
  id: z.string().min(1),
  title: z.array(richTextSchema),
  data_sources: z.array(z.looseObject({
    id: z.string().min(1),
    name: z.string(),
  })),
});

const propertySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  type: z.string().min(1),
  select: z.looseObject({
    options: z.array(z.looseObject({ name: z.string() })),
  }).optional(),
  multi_select: z.looseObject({
    options: z.array(z.looseObject({ name: z.string() })),
  }).optional(),
});

const dataSourceSchema = z.looseObject({
  object: z.literal('data_source'),
  id: z.string().min(1),
  title: z.array(richTextSchema).optional(),
  properties: z.record(z.string(), propertySchema),
});

export async function checkNotionConnection(
  client: NotionReadClient,
  databaseId: string,
): Promise<NotionConnectionReport> {
  let rawDatabase: unknown;
  try {
    rawDatabase = await client.retrieveDatabase(databaseId);
  } catch (error) {
    throw mapNotionApiError(error, 'database');
  }

  const database = databaseSchema.safeParse(rawDatabase);
  if (!database.success) {
    throw new NotionCheckError(
      'The Notion database response did not include a title and data_sources.',
    );
  }
  if (database.data.data_sources.length === 0) {
    throw new NotionCheckError('No data sources were found in the database.');
  }

  const dataSources: NotionDataSourceInfo[] = [];
  for (const reference of database.data.data_sources) {
    let rawDataSource: unknown;
    try {
      rawDataSource = await client.retrieveDataSource(reference.id);
    } catch (error) {
      throw mapNotionApiError(error, 'data_source');
    }
    const parsed = dataSourceSchema.safeParse(rawDataSource);
    if (!parsed.success) {
      throw new NotionCheckError(
        `The Notion data source response was incomplete. Data source ID: ${reference.id}`,
      );
    }
    dataSources.push({
      name: reference.name || richTextToPlainText(parsed.data.title ?? []) || '(untitled)',
      id: parsed.data.id,
      properties: Object.entries(parsed.data.properties).map(([key, property]) => ({
        name: property.name ?? key,
        id: property.id,
        type: property.type,
        options: property.type === 'select'
          ? (property.select?.options ?? []).map((option) => option.name)
          : property.type === 'multi_select'
            ? (property.multi_select?.options ?? []).map((option) => option.name)
            : [],
      })),
    });
  }

  return {
    databaseName: richTextToPlainText(database.data.title) || '(untitled)',
    databaseId: database.data.id,
    dataSources,
  };
}

function richTextToPlainText(values: Array<{ plain_text: string }>): string {
  return values.map((value) => value.plain_text).join('').trim();
}
