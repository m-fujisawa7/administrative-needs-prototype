export type NotionReadClient = {
  retrieveDatabase: (databaseId: string) => Promise<unknown>;
  retrieveDataSource: (dataSourceId: string) => Promise<unknown>;
};

export type NotionPageProperties = Record<string, unknown>;

export type NotionRegistrationClient = NotionReadClient & {
  queryDataSourceByUrl: (
    dataSourceId: string,
    propertyName: string,
    url: string,
  ) => Promise<unknown>;
  createPage: (
    dataSourceId: string,
    properties: NotionPageProperties,
  ) => Promise<unknown>;
};

export type NotionPropertyInfo = {
  name: string;
  id: string;
  type: string;
  options: string[];
};

export type NotionDataSourceInfo = {
  name: string;
  id: string;
  properties: NotionPropertyInfo[];
};

export type NotionConnectionReport = {
  databaseName: string;
  databaseId: string;
  dataSources: NotionDataSourceInfo[];
};

export type NotionCheckTarget = {
  databaseId: string;
};
