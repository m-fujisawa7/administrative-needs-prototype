import type { AdministrativeNeedCategory } from '../ai/categories.ts';
import type {
  AdministrativeNeedAnalyzer,
  AiCheckResult,
  AiCheckWarning,
  CompanyFitCriteria,
} from '../ai/types.ts';
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
  categories: AdministrativeNeedCategory[];
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

export type NotionRegistrationAnalysisContext = {
  analyzer: AdministrativeNeedAnalyzer;
  companyFitCriteria: CompanyFitCriteria;
};

export type RegisterOneFailureStage =
  | 'duplicate_check'
  | 'html_fetch'
  | 'pdf_extraction'
  | 'ai_analysis'
  | 'ai_validation'
  | 'notion_schema'
  | 'notion_select_options'
  | 'notion_create';

type RegisterOneBaseResult = {
  officialUrl: string;
  warnings: AiCheckWarning[];
};

export type RegisterOneResult =
  | RegisterOneBaseResult & {
    status: 'created';
    title: string;
    notionPageId: string;
    notionPageUrl: string;
    preview: NotionRegistrationPreview;
  }
  | RegisterOneBaseResult & {
    status: 'previewed';
    title: string;
    preview: NotionRegistrationPreview;
  }
  | RegisterOneBaseResult & {
    status: 'duplicate';
    existingPageId: string;
    existingPageUrl: string;
    phase: 'preflight' | 'before_create';
    preview?: NotionRegistrationPreview;
  }
  | RegisterOneBaseResult & {
    status: 'failed';
    stage: RegisterOneFailureStage;
    message: string;
    configurationError: boolean;
    preview?: NotionRegistrationPreview;
  };
