export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/gu, '');
}

export function canonicalUrlWithoutHash(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

export function parseDateCandidate(value: string): string | null {
  const normalized = value.normalize('NFKC');

  // 千葉県の一覧のように和暦へ括弧付き西暦を併記する表記がある。NFKC正規化で全角括弧も
  // 半角になるため1つのパターンで扱える。西暦だけを見る既存パターンは括弧が挟まると一致しない。
  // 令和年と括弧内の西暦が一致する場合だけ採用し、一致しない表記は後続のパターンへ委ねる。
  const reiwaWithWestern = normalized.match(
    /令和\s*(\d{1,2})\s*\(\s*(20\d{2})\s*\)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (
    reiwaWithWestern !== null
    && 2018 + Number(reiwaWithWestern[1]) === Number(reiwaWithWestern[2])
  ) {
    return formatDate(
      Number(reiwaWithWestern[2]),
      Number(reiwaWithWestern[3]),
      Number(reiwaWithWestern[4]),
    );
  }

  const western = normalized.match(/\b(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?/u);
  if (western !== null) {
    return formatDate(Number(western[1]), Number(western[2]), Number(western[3]));
  }

  const reiwa = normalized.match(/令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/u);
  if (reiwa !== null) {
    return formatDate(2018 + Number(reiwa[1]), Number(reiwa[2]), Number(reiwa[3]));
  }

  // 宮城県のプロポーザル一覧のように、公告日を「R8.8.5」と省略表記する自治体がある。
  // バージョン番号などの誤検知を避けるため、行頭・空白・括弧に続く独立したトークンだけを見る。
  const reiwaAbbreviation = normalized.match(
    /(?:^|[\s（(【[])R(\d{1,2})\.(\d{1,2})\.(\d{1,2})(?![\d.])/u,
  );
  if (reiwaAbbreviation !== null) {
    return formatDate(
      2018 + Number(reiwaAbbreviation[1]),
      Number(reiwaAbbreviation[2]),
      Number(reiwaAbbreviation[3]),
    );
  }

  const rfc822 = normalized.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})\b/iu);
  if (rfc822 !== null) {
    const month = MONTHS[rfc822[2]!.toLocaleLowerCase('en')];
    if (month !== undefined) return formatDate(Number(rfc822[3]), month, Number(rfc822[1]));
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function formatDate(year: number, month: number, day: number): string | null {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
