import { z } from 'zod';

export const ORGANIZATION_TYPES = [
  'designated_city',
  'prefecture',
  'municipality',
  'special_ward',
  'public_agency',
  'external_organization',
] as const;

export const COLLECTOR_TYPES = [
  'rss',
  'list_page',
  'single_page',
  'manual',
  'custom',
] as const;

export const SOURCE_CATEGORIES = [
  'procurement',
  'rfi',
  'proposal',
  'public_private_partnership',
  'digital_news',
  'policy_signal',
  'budget',
  'council',
  'plan',
  'other',
] as const;

export const PRIORITIES = ['high', 'medium', 'low'] as const;

export const VERIFICATION_STATUSES = [
  'verified',
  'unverified',
  'needs_review',
] as const;

const idSchema = z
  .string()
  .min(1, 'IDは必須です。')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'IDは小文字英数字とハイフンで指定してください。');

const httpUrlSchema = z
  .url('http または https の正しいURLを指定してください。')
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'URLのスキームは http または https にしてください。');

const selectorSchema = z
  .string()
  .trim()
  .min(1, 'CSSセレクターを空にすることはできません。')
  .refine((value) => !value.includes('\0'), 'CSSセレクターにNUL文字は使用できません。');

export const organizationSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1, '組織名は必須です。'),
  organization_type: z.enum(ORGANIZATION_TYPES),
  official_domain: z.string().trim().min(1, '公式ドメインは必須です。'),
  enabled: z.boolean(),
  prefecture: z.string().trim().min(1).optional(),
  parent_organization_id: idSchema.optional(),
  notes: z.string().trim().min(1).optional(),
});

export const sourceSchema = z.strictObject({
  id: idSchema,
  organization_id: idSchema,
  name: z.string().trim().min(1, '情報源名は必須です。'),
  url: httpUrlSchema,
  collector_type: z.enum(COLLECTOR_TYPES),
  source_category: z.enum(SOURCE_CATEGORIES),
  priority: z.enum(PRIORITIES),
  enabled: z.boolean(),
  link_selector: selectorSchema.optional(),
  content_selector: selectorSchema.optional(),
  category_includes: z.array(z.string().trim().min(1)).optional(),
  /** 1件以上設定した場合、いずれかの語をタイトルに含む候補だけを残す。 */
  title_includes: z.array(z.string().trim().min(1)).optional(),
  title_excludes: z.array(z.string().trim().min(1)).optional(),
  document_type_hints: z.array(z.string().trim().min(1)).optional(),
  notes: z.string().trim().min(1).optional(),
  last_verified_at: z.iso.date().optional(),
  verification_status: z.enum(VERIFICATION_STATUSES).optional(),
  /** この情報源だけ初回収集の開始日を変える場合に指定する。省略時は共通の初回収集開始日を使う。 */
  initial_since: z.iso.date().optional(),
  /** 募集中のものだけを載せる一覧など、候補0件が正常状態になり得る場合に true にする。`list_page` だけが読み取る。 */
  allow_empty_candidates: z.boolean().optional(),
});

export const sourceRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    organizations: z.array(organizationSchema).min(1, '組織を1件以上登録してください。'),
    sources: z.array(sourceSchema),
  })
  .superRefine((registry, context) => {
    addDuplicateIssues(
      registry.organizations.map((organization) => organization.id),
      'organizations',
      '組織ID',
      context,
    );
    addDuplicateIssues(
      registry.sources.map((source) => source.id),
      'sources',
      '情報源ID',
      context,
    );
    addDuplicateIssues(
      registry.sources.map((source) => canonicalUrl(source.url)),
      'sources',
      '情報源URL',
      context,
      'url',
    );

    const organizationIds = new Set(registry.organizations.map((organization) => organization.id));
    registry.organizations.forEach((organization, index) => {
      const parentId = organization.parent_organization_id;
      if (parentId !== undefined && !organizationIds.has(parentId)) {
        context.addIssue({
          code: 'custom',
          path: ['organizations', index, 'parent_organization_id'],
          message: `親組織「${parentId}」が organizations に定義されていません。`,
        });
      }
    });
    registry.sources.forEach((source, index) => {
      if (!organizationIds.has(source.organization_id)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'organization_id'],
          message: `組織「${source.organization_id}」が organizations に定義されていません。`,
        });
      }
    });
  });

export type Organization = z.infer<typeof organizationSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SourceRegistry = z.infer<typeof sourceRegistrySchema>;
export type Priority = (typeof PRIORITIES)[number];

export function validateSourceRegistry(input: unknown): SourceRegistry {
  return sourceRegistrySchema.parse(input);
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function addDuplicateIssues(
  values: string[],
  collectionName: 'organizations' | 'sources',
  label: string,
  context: z.RefinementCtx,
  fieldName = 'id',
): void {
  const firstIndexByValue = new Map<string, number>();
  values.forEach((value, index) => {
    const firstIndex = firstIndexByValue.get(value);
    if (firstIndex === undefined) {
      firstIndexByValue.set(value, index);
      return;
    }
    context.addIssue({
      code: 'custom',
      path: [collectionName, index, fieldName],
      message: `${label}「${value}」が ${collectionName}[${firstIndex}] と重複しています。`,
    });
  });
}
