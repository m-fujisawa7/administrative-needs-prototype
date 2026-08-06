export const AI_PROVIDERS = ['claude_cli', 'mock'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DOCUMENT_TYPES = [
  'rfi',
  'sounding',
  'private_proposal',
  'proposal',
  'bid',
  'pilot',
  'public_private_partnership',
  'plan',
  'council',
  'budget',
  'committee',
  'administrative_evaluation',
  'other',
] as const;
export type AdministrativeDocumentType = (typeof DOCUMENT_TYPES)[number];

export const AI_CATEGORIES = [
  'website',
  'cms',
  'ui_ux',
  'cx_service_design',
  'online_application',
  'administrative_dx',
  'bpr',
  'ai',
  'data_utilization',
  'open_data',
  'citizen_digital_service',
  'app',
  'digital_communication',
  'digital_marketing',
  'content',
  'tourism_regional_promotion',
  'business_support',
  'digital_skills',
  'in_house_support',
  'public_private_partnership',
  'digital_pilot',
  'enterprise_system',
  'security_cloud_network',
  'other',
] as const;
export type AdministrativeNeedCategory = (typeof AI_CATEGORIES)[number];

export const COMPANY_RELEVANCE_VALUES = ['A', 'B', 'C', 'out_of_scope'] as const;
export type CompanyRelevance = (typeof COMPANY_RELEVANCE_VALUES)[number];

export const CONTACT_RECOMMENDATION_VALUES = ['high', 'medium', 'low', 'none'] as const;
export type ContactRecommendation = (typeof CONTACT_RECOMMENDATION_VALUES)[number];

export type CompanyFitCriteria = {
  version: 1;
  name: string;
  directFit: string[];
  partnerFit: string[];
  strategicInterest: string[];
  outOfScope: string[];
  notes?: string;
};

export type AnalysisPdfDocument = {
  url: string;
  text: string;
};

export type AdministrativeNeedAnalysisInput = {
  title: string;
  officialUrl: string;
  organizationName: string;
  sourceName: string;
  htmlText: string;
  pdfDocuments: AnalysisPdfDocument[];
  companyFitCriteria: CompanyFitCriteria;
};

export type EvidenceQuote = {
  source_type: 'html' | 'pdf';
  source_url: string;
  quote: string;
};

export type AdministrativeNeedAnalysis = {
  is_target: boolean;
  document_type: AdministrativeDocumentType;
  problem_summary: string;
  desired_state: string;
  request_to_private_sector: string;
  categories: AdministrativeNeedCategory[];
  company_relevance: CompanyRelevance;
  contact_recommendation: ContactRecommendation;
  reason: string;
  evidence_quotes: EvidenceQuote[];
};

export interface AdministrativeNeedAnalyzer {
  readonly provider: AiProvider;
  readonly model: string | null;
  analyze(input: AdministrativeNeedAnalysisInput): Promise<AdministrativeNeedAnalysis>;
}

export type AiCheckWarningCode =
  | 'content_warning'
  | 'pdf_limit'
  | 'pdf_failed'
  | 'pdf_warning'
  | 'html_truncated'
  | 'pdf_truncated'
  | 'evidence_not_found';

export type AiCheckWarning = {
  code: AiCheckWarningCode;
  message: string;
};

export type AiInputSummary = {
  htmlOriginalCharacters: number;
  htmlSentCharacters: number;
  pdfDiscovered: number;
  pdfAttempted: number;
  pdfIncluded: number;
  pdfOriginalCharacters: number;
  pdfSentCharacters: number;
};

export type AiCheckResult = {
  sourceId: string;
  sourceName: string;
  organizationName: string;
  title: string;
  requestedUrl: string;
  officialUrl: string;
  provider: AiProvider;
  model: string | null;
  analysis: AdministrativeNeedAnalysis;
  inputSummary: AiInputSummary;
  evidenceMatched: number;
  warnings: AiCheckWarning[];
};

export type AiCheckCliOptions = {
  sourceId: string;
  url: string;
  json: boolean;
  noPdf: boolean;
};
