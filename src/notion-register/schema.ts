import type {
  NotionConnectionReport,
  NotionDataSourceInfo,
} from '../notion-check/types.ts';
import { NotionRegistrationError } from './errors.ts';
import type {
  MissingNotionOption,
  NotionRegistrationValues,
} from './types.ts';

export const EXPECTED_NOTION_PROPERTIES = {
  案件名: 'title',
  公式URL: 'url',
  自治体: 'rich_text',
  情報源: 'rich_text',
  対象判定: 'select',
  文書種別: 'select',
  行政課題: 'rich_text',
  実現したい状態: 'rich_text',
  民間に求めること: 'rich_text',
  分野: 'multi_select',
  自社関連度: 'select',
  コンタクト推奨度: 'select',
  判断理由: 'rich_text',
  根拠引用: 'rich_text',
  確認状態: 'select',
  登録日時: 'created_time',
} as const;

export function selectRegistrationDataSource(
  report: NotionConnectionReport,
): NotionDataSourceInfo {
  if (report.dataSources.length !== 1) {
    throw new NotionRegistrationError(
      'Multiple data sources were found.\nSpecify the target data source before writing.',
    );
  }
  return report.dataSources[0]!;
}

export function validateRegistrationSchema(dataSource: NotionDataSourceInfo): void {
  const actual = new Map(dataSource.properties.map((property) => [property.name, property]));
  const mismatches: string[] = [];
  for (const [name, expectedType] of Object.entries(EXPECTED_NOTION_PROPERTIES)) {
    const property = actual.get(name);
    if (property === undefined) {
      mismatches.push(`- ${name}: expected ${expectedType}, actual missing`);
      continue;
    }
    if (property.type !== expectedType) {
      mismatches.push(`- ${name}: expected ${expectedType}, actual ${property.type}`);
    }
  }
  if (mismatches.length > 0) {
    throw new NotionRegistrationError([
      'The Notion data source schema does not match the expected schema.',
      ...mismatches,
    ].join('\n'));
  }
}

export function findMissingNotionOptions(
  dataSource: NotionDataSourceInfo,
  values: NotionRegistrationValues,
): MissingNotionOption[] {
  const requested = new Map<string, string[]>([
    ['対象判定', [values.target]],
    ['文書種別', [values.documentType]],
    ['分野', values.categories],
    ['自社関連度', [values.companyRelevance]],
    ['コンタクト推奨度', [values.contactRecommendation]],
    ['確認状態', [values.confirmationStatus]],
  ]);
  const properties = new Map(dataSource.properties.map((property) => [property.name, property]));
  const missing: MissingNotionOption[] = [];
  for (const [propertyName, optionNames] of requested) {
    const existing = new Set(properties.get(propertyName)?.options ?? []);
    for (const optionName of optionNames) {
      if (!existing.has(optionName)) missing.push({ propertyName, optionName });
    }
  }
  return missing;
}
