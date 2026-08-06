import type { AiCheckResult } from '../ai/types.ts';
import type {
  NotionDataSourceInfo,
  NotionPageProperties,
} from '../notion-check/types.ts';

export type NotionRegisterCliOptions = {
  sourceId: string;
  url: string;
  databaseId: string;
  write: boolean;
};

export type NotionRegistrationValues = {
  title: string;
  officialUrl: string;
  organizationName: string;
  sourceName: string;
  target: '対象' | '対象外';
  documentType: string;
  problem: string;
  desiredState: string;
  requestToPrivateSector: string;
  categories: string[];
  companyRelevance: 'A' | 'B' | 'C' | '対象外';
  contactRecommendation: '高' | '中' | '低' | '不要';
  reason: string;
  evidence: string;
  confirmationStatus: '未確認' | '対象外';
};

export type MissingNotionOption = {
  propertyName: string;
  optionName: string;
};

export type ExistingNotionPage = {
  id: string;
  url: string;
};

export type NotionRegistrationPreview = {
  databaseName: string;
  dataSource: NotionDataSourceInfo;
  sourceId: string;
  analysisResult: AiCheckResult;
  values: NotionRegistrationValues;
  properties: NotionPageProperties;
  duplicate: ExistingNotionPage | null;
  missingOptions: MissingNotionOption[];
  write: boolean;
};

export type CreatedNotionPage = {
  id: string;
  url: string;
};
