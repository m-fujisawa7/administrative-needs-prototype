import { Client } from '@notionhq/client';
import type {
  NotionReadClient,
  NotionRegistrationClient,
} from './types.ts';

export const NOTION_API_VERSION = '2026-03-11';

export function createNotionReadClient(token: string): NotionReadClient {
  return readMethods(createClient(token));
}

export function createNotionRegistrationClient(token: string): NotionRegistrationClient {
  const notion = createClient(token);
  return {
    ...readMethods(notion),
    queryDataSourceByUrl: (dataSourceId, propertyName, url) => notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        property: propertyName,
        url: { equals: url },
      },
      page_size: 1,
      result_type: 'page',
    }),
    createPage: (dataSourceId, properties) => notion.pages.create({
      parent: {
        type: 'data_source_id',
        data_source_id: dataSourceId,
      },
      properties: properties as Parameters<typeof notion.pages.create>[0]['properties'],
    }),
  };
}

function createClient(token: string): Client {
  return new Client({
    auth: token,
    notionVersion: NOTION_API_VERSION,
    logger: () => undefined,
    retry: false,
  });
}

function readMethods(notion: Client): NotionReadClient {
  return {
    retrieveDatabase: (databaseId) => notion.databases.retrieve({ database_id: databaseId }),
    retrieveDataSource: (dataSourceId) => notion.dataSources.retrieve({
      data_source_id: dataSourceId,
    }),
  };
}
