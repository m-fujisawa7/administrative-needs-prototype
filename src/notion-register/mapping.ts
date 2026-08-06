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

const CATEGORY_LABELS: Record<AiCheckResult['analysis']['categories'][number], string> = {
  website: 'Webサイト',
  cms: 'CMS',
  ui_ux: 'UI・UX',
  cx_service_design: 'CX・サービスデザイン',
  online_application: 'オンライン申請',
  administrative_dx: '行政DX',
  bpr: 'BPR・業務改善',
  ai: 'AI・生成AI',
  data_utilization: 'データ活用',
  open_data: 'オープンデータ',
  citizen_digital_service: '市民向けデジタルサービス',
  app: 'アプリ',
  digital_communication: 'デジタル広報・コミュニケーション',
  digital_marketing: 'デジタルマーケティング',
  content: 'コンテンツ制作・運用',
  tourism_regional_promotion: '観光・移住・企業誘致',
  business_support: '地域事業者支援',
  digital_skills: 'デジタル人材育成',
  in_house_support: '内製化支援',
  public_private_partnership: '官民連携',
  digital_pilot: 'デジタル実証',
  enterprise_system: '大規模・基幹システム',
  security_cloud_network: 'セキュリティ・クラウド・通信',
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
    categories: [...new Set(result.analysis.categories.map((category) => mappedValue(
      CATEGORY_LABELS,
      category,
      'category',
    )))],
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
