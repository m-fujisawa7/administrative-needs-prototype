import type { RegisterOneResult } from '../notion-register/types.ts';

export type NotionBatchCliOptions = {
  sourceId: string;
  file: string;
  databaseId: string;
  write: boolean;
};

export type SelectedUrlEntry = {
  officialUrl: string;
  inputDuplicate: boolean;
};

export type ParsedSelectedUrls = {
  entries: SelectedUrlEntry[];
  uniqueUrlCount: number;
};

export type InputDuplicateResult = {
  status: 'input_duplicate';
  officialUrl: string;
  warnings: [];
};

export type NotionBatchItemResult = RegisterOneResult | InputDuplicateResult;

export type NotionBatchReport = {
  write: boolean;
  inputLines: number;
  validUniqueUrls: number;
  results: NotionBatchItemResult[];
};
