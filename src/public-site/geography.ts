export type PublicRegionDefinition = {
  id: string;
  name: string;
  prefectures: readonly string[];
};

/**
 * 公開ページで使用する、北から南への地域・都道府県順。
 * 自治体の所属都道府県は台帳の prefecture を正本とし、名称から推測しない。
 */
export const PUBLIC_REGIONS = [
  {
    id: 'hokkaido',
    name: '北海道',
    prefectures: ['北海道'],
  },
  {
    id: 'tohoku',
    name: '東北',
    prefectures: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
  },
  {
    id: 'kanto',
    name: '関東',
    prefectures: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'],
  },
  {
    id: 'chubu',
    name: '中部',
    prefectures: [
      '新潟県',
      '富山県',
      '石川県',
      '福井県',
      '山梨県',
      '長野県',
      '岐阜県',
      '静岡県',
      '愛知県',
    ],
  },
  {
    id: 'kinki',
    name: '近畿',
    prefectures: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
  },
  {
    id: 'chugoku',
    name: '中国',
    prefectures: ['鳥取県', '島根県', '岡山県', '広島県', '山口県'],
  },
  {
    id: 'shikoku',
    name: '四国',
    prefectures: ['徳島県', '香川県', '愛媛県', '高知県'],
  },
  {
    id: 'kyushu-okinawa',
    name: '九州・沖縄',
    prefectures: [
      '福岡県',
      '佐賀県',
      '長崎県',
      '熊本県',
      '大分県',
      '宮崎県',
      '鹿児島県',
      '沖縄県',
    ],
  },
] as const satisfies readonly PublicRegionDefinition[];

export type PublicRegionId = (typeof PUBLIC_REGIONS)[number]['id'];

export type PrefectureLocation = {
  regionId: PublicRegionId;
  prefectureOrder: number;
};

const prefectureLocations = new Map<string, PrefectureLocation>(
  PUBLIC_REGIONS.flatMap((region) =>
    region.prefectures.map((prefecture, prefectureOrder) => [
      prefecture,
      { regionId: region.id, prefectureOrder },
    ] as const),
  ),
);

export function findPrefectureLocation(prefecture: string): PrefectureLocation | undefined {
  return prefectureLocations.get(prefecture);
}
