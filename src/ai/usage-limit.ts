/**
 * Claude CLIの利用上限メッセージを検知する。
 *
 * 通常のCLI失敗と区別するため、実際に返る「You've hit your limit」だけを判定に使う。
 * `limit` 単独やレート制限の文言では判定しない。
 */
const USAGE_LIMIT_PHRASE = /you've hit your limit/iu;

/**
 * 利用上限を検知した場合はその1行を返す。検知できない場合は null。
 *
 * `--output-format json` のstdoutがJSONなら、外側JSONの文字列値を先に調べる。
 * JSONとして解析できない場合でも raw stdout / stderr から判定する。
 */
export function detectClaudeUsageLimit(stdout: string, stderr: string): string | null {
  // JSONの文字列値を先に見ることで、JSON全体ではなくメッセージ本体を返す。
  for (const text of [...extractJsonStringValues(stdout), stdout, stderr]) {
    const line = findUsageLimitLine(text);
    if (line !== null) return line;
  }
  return null;
}

function findUsageLimitLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line !== '' && USAGE_LIMIT_PHRASE.test(normalizeApostrophes(line))) return line;
  }
  return null;
}

/** 曲がりアポストロフィを直線に寄せて、表記差だけの不一致を防ぐ。 */
function normalizeApostrophes(value: string): string {
  return value.replace(/[‘’ʼ]/gu, "'");
}

function extractJsonStringValues(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const values: string[] = [];
  collectStrings(parsed, values);
  return values;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}
