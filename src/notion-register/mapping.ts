import {
  isAdministrativeNeedCategory,
  type AdministrativeNeedCategory,
} from '../ai/categories.ts';
import type { AiCheckResult } from '../ai/types.ts';
import type { NotionPageProperties } from '../notion-check/types.ts';
import { NotionRegistrationError } from './errors.ts';
import type { NotionRegistrationValues } from './types.ts';

const DOCUMENT_TYPE_LABELS: Record<AiCheckResult['analysis']['document_type'], string> = {
  rfi: 'RFI',
  sounding: 'サウンディング',
  private_proposal: '民間提案',
  proposal: 'プロポーザル',
  bid: '入札',
  pilot: '実証事業',
  public_private_partnership: '官民連携',
  plan: '計画',
  council: '議会',
  budget: '予算',
  committee: '審議会',
  administrative_evaluation: '行政評価',
  other: 'その他',
};

const COMPANY_RELEVANCE_LABELS: Record<
  AiCheckResult['analysis']['company_relevance'],
  NotionRegistrationValues['companyRelevance']
> = {
  A: 'A',
  B: 'B',
  C: 'C',
  out_of_scope: '対象外',
};

const CONTACT_LABELS: Record<
  AiCheckResult['analysis']['contact_recommendation'],
  NotionRegistrationValues['contactRecommendation']
> = {
  high: '高',
  medium: '中',
  low: '低',
  none: '不要',
};

export function mapAnalysisToNotionValues(result: AiCheckResult): NotionRegistrationValues {
  const target = result.analysis.is_target ? '対象' : '対象外';
  return {
    title: result.title,
    officialUrl: result.officialUrl,
    organizationName: result.organizationName,
    sourceName: result.sourceName,
    target,
    documentType: mappedValue(
      DOCUMENT_TYPE_LABELS,
      result.analysis.document_type,
      'document_type',
    ),
    problem: result.analysis.problem_summary,
    desiredState: result.analysis.desired_state,
    requestToPrivateSector: result.analysis.request_to_private_sector,
    categories: validateCategories(result.analysis.categories),
    companyRelevance: mappedValue(
      COMPANY_RELEVANCE_LABELS,
      result.analysis.company_relevance,
      'company_relevance',
    ),
    contactRecommendation: mappedValue(
      CONTACT_LABELS,
      result.analysis.contact_recommendation,
      'contact_recommendation',
    ),
    reason: result.analysis.reason,
    evidence: result.analysis.evidence_quotes
      .map((evidence) => `・${evidence.quote}`)
      .join('\n'),
    confirmationStatus: target === '対象' ? '未確認' : '対象外',
  };
}

function validateCategories(categories: readonly string[]): AdministrativeNeedCategory[] {
  for (const category of categories) {
    if (!isAdministrativeNeedCategory(category)) {
      throw new NotionRegistrationError(
        `Unsupported category value for Notion: ${category}`,
      );
    }
  }
  return [...categories] as AdministrativeNeedCategory[];
}

export function buildNotionPageProperties(
  values: NotionRegistrationValues,
): NotionPageProperties {
  return {
    案件名: { title: richText(values.title) },
    公式URL: { url: values.officialUrl },
    自治体: { rich_text: richText(values.organizationName) },
    情報源: { rich_text: richText(values.sourceName) },
    対象判定: { select: { name: values.target } },
    文書種別: { select: { name: values.documentType } },
    行政課題: { rich_text: richText(values.problem) },
    実現したい状態: { rich_text: richText(values.desiredState) },
    民間に求めること: { rich_text: richText(values.requestToPrivateSector) },
    分野: { multi_select: values.categories.map((name) => ({ name })) },
    自社関連度: { select: { name: values.companyRelevance } },
    コンタクト推奨度: { select: { name: values.contactRecommendation } },
    判断理由: { rich_text: richText(values.reason) },
    根拠引用: { rich_text: richText(values.evidence) },
    確認状態: { select: { name: values.confirmationStatus } },
  };
}

function richText(value: string): Array<{
  type: 'text';
  text: { content: string };
}> {
  if (value === '') return [];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 2_000) {
    chunks.push(value.slice(index, index + 2_000));
  }
  return chunks.map((content) => ({
    type: 'text',
    text: { content },
  }));
}

function mappedValue<Key extends string, Value>(
  mapping: Record<Key, Value>,
  key: string,
  fieldName: string,
): Value {
  if (Object.hasOwn(mapping, key)) return mapping[key as Key];
  throw new NotionRegistrationError(
    `Unsupported ${fieldName} value for Notion: ${key}`,
  );
}
