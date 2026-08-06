const CATEGORY_DEFINITIONS = [
  {
    name: 'Web・CMS',
    criteria: [
      '自治体Webサイト、ホームページ、ポータルサイト、特設サイト',
      'CMS、Webサイトリニューアル、Web運用',
    ],
  },
  {
    name: 'UI・UX',
    criteria: [
      '画面設計、情報設計、ユーザビリティ、アクセシビリティ',
      '利用者体験、導線改善',
    ],
  },
  {
    name: 'サービスデザイン',
    criteria: [
      '市民体験、CX、利用者調査、ジャーニーマップ',
      '行政サービスの横断的な設計、利用者起点のサービス改善',
    ],
  },
  {
    name: '行政DX',
    criteria: [
      '自治体全体のDX、デジタル接点の改善、行政サービスのデジタル化',
      'デジタル技術による自治体改革、DX推進計画',
    ],
  },
  {
    name: 'BPR・業務改善',
    criteria: [
      '業務フローの見直し、業務効率化、事務処理改善',
      'バックオフィス改善、業務調査、運用設計',
    ],
  },
  {
    name: 'オンライン手続き',
    criteria: [
      '電子申請、オンライン申請、手続きのオンライン化',
      '申請フォーム、窓口手続きのデジタル化',
    ],
  },
  {
    name: 'AI・生成AI',
    criteria: [
      'AI、生成AI、機械学習、AIチャット',
      'AIによる業務支援、AIを利用した市民サービス',
    ],
  },
  {
    name: 'データ活用',
    criteria: [
      'データ分析、データ連携、オープンデータ、ダッシュボード',
      'BI、データ基盤、EBPM',
    ],
  },
  {
    name: 'デジタル広報',
    criteria: [
      'Web広報、SNS運用、デジタルマーケティング、コンテンツ制作',
      '観光情報発信、移住・定住情報発信、採用広報',
    ],
  },
  {
    name: 'アプリ・LINE・チャットボット',
    criteria: [
      'スマートフォンアプリ、LINE公式アカウント、チャットボット',
      'メッセージ配信、プッシュ通知、モバイルサービス',
    ],
  },
  {
    name: '官民連携・実証',
    criteria: [
      '官民連携、実証実験、PoC、民間提案、サウンディング',
      '共同事業、スタートアップ連携',
    ],
  },
  {
    name: 'その他',
    criteria: [
      '対象案件ではあるものの、他の11種類のどれにも適切に分類できないもの',
    ],
  },
] as const;

export type AdministrativeNeedCategory =
  (typeof CATEGORY_DEFINITIONS)[number]['name'];

export const ADMINISTRATIVE_NEED_CATEGORIES = Object.freeze(
  CATEGORY_DEFINITIONS.map((definition) => definition.name),
) as readonly [AdministrativeNeedCategory, ...AdministrativeNeedCategory[]];

const CATEGORY_SET = new Set<string>(ADMINISTRATIVE_NEED_CATEGORIES);

export function isAdministrativeNeedCategory(
  value: string,
): value is AdministrativeNeedCategory {
  return CATEGORY_SET.has(value);
}

export function formatAdministrativeNeedCategoryOptions(): string {
  return CATEGORY_DEFINITIONS
    .map((definition) => `- ${definition.name}: ${definition.criteria.join('。')}`)
    .join('\n');
}
