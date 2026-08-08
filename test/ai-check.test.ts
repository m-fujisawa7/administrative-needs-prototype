import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ADMINISTRATIVE_NEED_CATEGORIES } from '../src/ai/categories.ts';
import { checkAdministrativeNeed } from '../src/ai/check.ts';
import { ClaudeCliAnalyzer, parseClaudeOutput } from '../src/ai/claude-cli.ts';
import { loadCompanyFitCriteria } from '../src/ai/company-fit-criteria.ts';
import { createAnalyzer } from '../src/ai/create-analyzer.ts';
import { AiAnalyzerError, AiConfigurationError } from '../src/ai/errors.ts';
import {
  aiInputLimitsFromEnvironment,
  prepareAnalysisInput,
  truncateHeadTail,
  validateEvidenceQuotes,
} from '../src/ai/input.ts';
import { MockAnalyzer } from '../src/ai/mock.ts';
import {
  formatAnalysisInput,
  loadAiCheckPrompt,
  renderAiCheckPrompt,
} from '../src/ai/prompt.ts';
import { runChildProcess, type ChildProcessRequest } from '../src/ai/process.ts';
import {
  administrativeNeedJsonSchema,
  parseAdministrativeNeedAnalysis,
} from '../src/ai/schema.ts';
import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AiCheckResult,
  CompanyFitCriteria,
} from '../src/ai/types.ts';
import {
  formatAiCheckResult,
  parseAiCheckArgs,
  runAiCheck,
} from '../src/commands/ai-check.ts';
import type { ExtractedDocument } from '../src/content-check/types.ts';
import type { ExtractedPdf } from '../src/pdf-check/types.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../src/source-registry/schema.ts';

const DOCUMENT_URL = 'https://www.city.osaka.lg.jp/page/document.html';
const PDF_A = 'https://www.city.osaka.lg.jp/files/a.pdf';
const PDF_B = 'https://www.city.osaka.lg.jp/files/b.pdf';
const PDF_C = 'https://www.city.osaka.lg.jp/files/c.pdf';

describe('AI出力スキーマ', () => {
  it('対象案件で固定カテゴリ1件と3件を受理する', () => {
    expect(parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['行政DX'],
    })).categories).toEqual(['行政DX']);
    expect(parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['サービスデザイン', '行政DX', 'AI・生成AI'],
    })).categories).toHaveLength(3);
  });

  it('対象外の空配列と対象案件の「その他」単独を受理する', () => {
    expect(parseAdministrativeNeedAnalysis(validAnalysis({
      is_target: false,
      problem_summary: '',
      desired_state: '',
      request_to_private_sector: '',
      categories: [],
      company_relevance: 'out_of_scope',
      contact_recommendation: 'none',
    })).is_target).toBe(false);
    expect(parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['その他'],
    })).categories).toEqual(['その他']);
  });

  it('不正な列挙値、配列型、未知キーを拒否する', () => {
    expect(() => parseAdministrativeNeedAnalysis({
      ...validAnalysis(),
      document_type: '情報提供依頼',
    })).toThrow();
    expect(() => parseAdministrativeNeedAnalysis({
      ...validAnalysis(),
      categories: '行政DX',
    })).toThrow();
    expect(() => parseAdministrativeNeedAnalysis({
      ...validAnalysis(),
      unknown: true,
    })).toThrow();
  });

  it.each([
    'Webサイト',
    'CX・サービスデザイン',
    'オンライン申請',
    '市民向けデジタルサービス',
    'デジタル広報・コミュニケーション',
  ])('固定候補外のカテゴリ「%s」を拒否する', (category) => {
    expect(() => parseAdministrativeNeedAnalysis({
      ...validAnalysis(),
      categories: [category],
    })).toThrow();
  });

  it('カテゴリの対象整合性と最大3件を検証する', () => {
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      categories: [],
    }))).toThrow('1件以上');
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['Web・CMS', 'UI・UX', '行政DX', 'AI・生成AI'],
    }))).toThrow();
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      is_target: false,
      categories: ['行政DX'],
      company_relevance: 'out_of_scope',
      contact_recommendation: 'none',
    }))).toThrow('空配列');
  });

  it('カテゴリの重複と「その他」の併用を拒否する', () => {
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['行政DX', '行政DX'],
    }))).toThrow('重複');
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      categories: ['その他', '行政DX'],
    }))).toThrow('併用');
  });

  it('対象外・自社関連度・コンタクト推奨度の整合性を検証する', () => {
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      is_target: false,
      company_relevance: 'A',
      contact_recommendation: 'high',
    }))).toThrow('out_of_scope');
    expect(() => parseAdministrativeNeedAnalysis(validAnalysis({
      company_relevance: 'C',
      contact_recommendation: 'high',
    }))).toThrow('A または B');
  });

  it('Claude CLIへ渡せるJSON Schemaを生成する', () => {
    const schema = administrativeNeedJsonSchema();
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: expect.objectContaining({
        is_target: { type: 'boolean' },
        categories: {
          type: 'array',
          items: { type: 'string', enum: [...ADMINISTRATIVE_NEED_CATEGORIES] },
          maxItems: 3,
        },
      }),
    });
  });
});

describe('AI入力組み立て', () => {
  it('リポジトリの自社適合度判定基準と外部プロンプトを読み込める', async () => {
    const [companyFitCriteria, prompt] = await Promise.all([
      loadCompanyFitCriteria(),
      loadAiCheckPrompt(),
    ]);
    expect(companyFitCriteria.directFit).toContain('Webサイト・ポータル構築');
    expect(companyFitCriteria.strategicInterest)
      .toContain('Webサイト・CMS刷新の構想・調査・計画段階');
    expect(prompt).toContain('最重要の安全ルール');
    expect(prompt).toContain('strategic_interest');
    expect(prompt).toContain('Markdownコードフェンスを付けず、JSONオブジェクトだけ');
    expect(ADMINISTRATIVE_NEED_CATEGORIES).toHaveLength(12);
    for (const category of ADMINISTRATIVE_NEED_CATEGORIES) {
      expect(prompt).toContain(`- ${category}:`);
    }
    expect(prompt).not.toContain('{{CATEGORY_OPTIONS}}');
  });

  it('カテゴリプレースホルダーがないプロンプトを拒否する', () => {
    expect(() => renderAiCheckPrompt('# プレースホルダーなし'))
      .toThrow('{{CATEGORY_OPTIONS}}');
  });

  it('HTML、複数PDF、自社適合度判定基準を信頼できない文書として区切る', () => {
    const prompt = formatAnalysisInput(makeInput({
      pdfDocuments: [
        { url: PDF_A, text: 'PDF A本文' },
        { url: PDF_B, text: 'PDF B本文' },
      ],
    }));

    expect(prompt).toContain('## 自社適合度判定基準');
    expect(prompt).toContain('strategic_interest（将来に向けて継続確認したい領域・段階');
    expect(prompt).toContain('SOURCE_TYPE: html');
    expect(prompt).toContain(`SOURCE_URL: ${PDF_A}`);
    expect(prompt.match(/<UNTRUSTED_DOCUMENT>/gu)).toHaveLength(3);
  });

  it('PDFが0件でも動作し、長文は先頭と末尾を残して切り詰める', () => {
    const value = `先頭${'中'.repeat(100)}末尾`;
    const truncated = truncateHeadTail(value, 40);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toHaveLength(40);
    expect(truncated.text).toContain('先頭');
    expect(truncated.text).toContain('末尾');
    expect(truncated.text).toContain('中間部分を省略');

    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      htmlText: value,
      pdfDocuments: [],
      pdfDiscovered: 0,
      pdfAttempted: 0,
      limits: { htmlCharacters: 40, pdfCharacters: 40, maxPdfs: 3 },
    });
    expect(prepared.input.pdfDocuments).toEqual([]);
    expect(prepared.warnings.map((warning) => warning.code)).toContain('html_truncated');
  });

  it('PDF本文合計の上限を複数PDFへ配分する', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: 'A'.repeat(80) },
        { url: PDF_B, text: 'B'.repeat(80) },
      ],
      pdfDiscovered: 2,
      pdfAttempted: 2,
      limits: { htmlCharacters: 1_000, pdfCharacters: 60, maxPdfs: 3 },
    });
    expect(prepared.summary.pdfSentCharacters).toBe(60);
    expect(prepared.input.pdfDocuments).toHaveLength(2);
    expect(prepared.warnings.map((warning) => warning.code)).toContain('pdf_truncated');
  });

  it('PDF本文合計が上限内なら文書間の配分で切り詰めない', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: 'A'.repeat(31_731) },
        { url: PDF_B, text: 'B'.repeat(4_924) },
      ],
      pdfDiscovered: 2,
      pdfAttempted: 2,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });
    expect(prepared.summary.pdfSentCharacters).toBe(36_655);
    expect(prepared.warnings.map((warning) => warning.code)).not.toContain('pdf_truncated');
  });

  it('環境変数の入力上限を検証する', () => {
    expect(aiInputLimitsFromEnvironment({ AI_MAX_PDFS: '5' })).toMatchObject({ maxPdfs: 5 });
    expect(() => aiInputLimitsFromEnvironment({ AI_MAX_PDFS: '0' }))
      .toThrow(AiConfigurationError);
  });
});

describe('根拠照合', () => {
  it('出典URLと原文を照合し、不一致をWarningにする', () => {
    const input = makeInput();
    const matched = validateEvidenceQuotes(validAnalysis(), input);
    expect(matched.matched).toBe(1);
    expect(matched.warnings).toEqual([]);

    const missing = validateEvidenceQuotes(validAnalysis({
      evidence_quotes: [{
        source_type: 'html',
        source_url: DOCUMENT_URL,
        quote: '入力に存在しない引用',
      }],
    }), input);
    expect(missing.matched).toBe(0);
    expect(missing.warnings[0]?.code).toBe('evidence_not_found');
  });

  /** 引用1件だけを渡して一致したかを返す。 */
  function matchOne(
    quote: string,
    options: { htmlText?: string; pdfText?: string } = {},
  ): boolean {
    const usePdf = options.pdfText !== undefined;
    const input = makeInput({
      ...(options.htmlText === undefined ? {} : { htmlText: options.htmlText }),
      ...(usePdf ? { pdfDocuments: [{ url: PDF_A, text: options.pdfText as string }] } : {}),
    });
    const result = validateEvidenceQuotes(validAnalysis({
      evidence_quotes: [{
        source_type: usePdf ? 'pdf' : 'html',
        source_url: usePdf ? PDF_A : DOCUMENT_URL,
        quote,
      }],
    }), input);
    return result.matched === 1;
  }

  it('完全一致する引用を通す', () => {
    expect(matchOne('行政サービスを改善するための情報提供', {
      htmlText: '行政サービスを改善するための情報提供を募集します。',
    })).toBe(true);
  });

  it('HTMLの改行差を吸収する', () => {
    expect(matchOne('行政サービスを改善する 情報提供を募集します', {
      htmlText: '行政サービスを改善する\n情報提供を募集します。',
    })).toBe(true);
  });

  it('HTMLの連続空白とタブ差を吸収する', () => {
    expect(matchOne('募集します 詳細は下記', {
      htmlText: '募集します。\n\n   \t 詳細は下記のとおりです。'.replace('。\n\n', ' '),
    })).toBe(true);
  });

  it('曲がり引用符と直線引用符の差を吸収する', () => {
    // 実例: 原文は “重点箇所だけへの訪問”、Claudeは "重点箇所だけへの訪問" を返した。
    expect(matchOne('現地調査を、"重点箇所だけへの訪問"に切り替えられるだろうか？', {
      htmlText: '職員が歩き回る現地調査を、“重点箇所だけへの訪問”に切り替えられるだろうか？',
    })).toBe(true);
    expect(matchOne('現地調査を、“重点箇所だけへの訪問”に切り替え', {
      htmlText: '職員が歩き回る現地調査を、"重点箇所だけへの訪問"に切り替えられるだろうか？',
    })).toBe(true);
  });

  it('単一引用符の曲がり・直線差も吸収する', () => {
    expect(matchOne("'重点箇所'への訪問", { htmlText: '‘重点箇所’への訪問に切り替える。' }))
      .toBe(true);
  });

  it('PDF抽出で日本語文字間に混入した空白を吸収する', () => {
    // 実例: unpdf の抽出結果は「行 政 課 題 1 件 あ た り 150 万 円 ま で」。
    expect(matchOne('行政課題 1件あたり 150万円まで', {
      pdfText: '行 政 課 題 1 件 あ た り 150 万 円 ま で\n社 会 課 題 1 件 あ た り 300 万 円 ま で',
    })).toBe(true);
  });

  it('PDF由来の空白入り引用を空白なし原文に照合できる', () => {
    expect(matchOne('行 政 課 題 1 件 あ た り 150 万 円', {
      pdfText: '行政課題 1件あたり 150万円まで',
    })).toBe(true);
  });

  it('欧文の単語間スペースは保持して誤一致させない', () => {
    expect(matchOne('open data', { htmlText: 'opendata の推進について' })).toBe(false);
    expect(matchOne('opendata', { htmlText: 'open data の推進について' })).toBe(false);
    expect(matchOne('open data', { htmlText: 'open data の推進について' })).toBe(true);
  });

  it('数字が異なる引用は一致させない', () => {
    expect(matchOne('行政課題 1件あたり 300万円まで', {
      pdfText: '行 政 課 題 1 件 あ た り 150 万 円 ま で',
    })).toBe(false);
  });

  it('言い換えた引用は一致させない', () => {
    expect(matchOne('行政課題1件につき最大150万円を補助します', {
      pdfText: '行 政 課 題 1 件 あ た り 150 万 円 ま で',
    })).toBe(false);
  });

  it('原文に存在しない引用は一致させない', () => {
    expect(matchOne('入力に存在しない引用', {
      htmlText: '行政サービスを改善するための情報提供を募集します。',
    })).toBe(false);
  });

  it('語順を入れ替えた引用は一致させない', () => {
    expect(matchOne('情報提供を募集します 行政サービスを改善する', {
      htmlText: '行政サービスを改善するための情報提供を募集します。',
    })).toBe(false);
  });

  it('出典種別が違えば一致させない', () => {
    const input = makeInput({
      htmlText: '行政課題1件あたり150万円まで',
      pdfDocuments: [{ url: PDF_A, text: '別の本文' }],
    });
    const result = validateEvidenceQuotes(validAnalysis({
      evidence_quotes: [{
        source_type: 'pdf',
        source_url: PDF_A,
        quote: '行政課題1件あたり150万円まで',
      }],
    }), input);
    expect(result.matched).toBe(0);
  });

  it('空の引用は一致させない', () => {
    expect(matchOne('   ', { htmlText: '行政サービスを改善する。' })).toBe(false);
  });
});

describe('Analyzer', () => {
  it('Mock AnalyzerはClaude CLIを呼ばず固定形式を返す', async () => {
    const analyzer = new MockAnalyzer();
    const result = await analyzer.analyze(makeInput());
    expect(result).toMatchObject({
      is_target: true,
      document_type: 'rfi',
      categories: ['サービスデザイン', '行政DX', 'UI・UX'],
      company_relevance: 'A',
      contact_recommendation: 'high',
    });
  });

  it('環境変数でMockとClaude CLIを選択し、未対応Providerを拒否する', () => {
    expect(createAnalyzer({ systemPrompt: 'prompt', env: { AI_PROVIDER: 'mock' } }).provider)
      .toBe('mock');
    expect(createAnalyzer({
      systemPrompt: 'prompt',
      env: { AI_PROVIDER: 'claude_cli' },
    }).provider).toBe('claude_cli');
    expect(() => createAnalyzer({
      systemPrompt: 'prompt',
      env: { AI_PROVIDER: 'unsupported' },
    })).toThrow('Unsupported AI_PROVIDER');
  });

  it('Claude CLIを最小引数で起動し、指示・スキーマ・本文をstdinで渡す', async () => {
    let request: ChildProcessRequest | undefined;
    let calls = 0;
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async (candidate) => {
        calls += 1;
        request = candidate;
        return {
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\``,
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      },
    });
    const result = await analyzer.analyze(makeInput());

    expect(result.document_type).toBe('rfi');
    expect(analyzer.model).toBeNull();
    expect(request?.executable).toBe('/path/to/claude');
    expect(request?.cwd).toBe(tmpdir());
    expect(request?.args).toEqual(['-p', '--output-format', 'json', '--max-turns', '1']);
    expect(request?.stdin).toContain('system prompt');
    expect(request?.stdin).toContain('# 出力JSON Schema');
    expect(request?.stdin).toContain('<UNTRUSTED_DOCUMENT>');
    expect(calls).toBe(1);
    expect(analyzer.getLastRunInfo()).toEqual({ jsonParseRetryCount: 0 });
  });

  it('行政ニーズJSONのparse失敗時だけ1回再試行し、再試行指示を追加する', async () => {
    const requests: ChildProcessRequest[] = [];
    const invalidJson = '{"quote":"... "重点箇所だけへの訪問" ..."}';
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async (request) => {
        requests.push(request);
        return {
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: requests.length === 1 ? invalidJson : JSON.stringify(validAnalysis()),
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      },
    });

    await expect(analyzer.analyze(makeInput())).resolves.toEqual(validAnalysis());
    expect(requests).toHaveLength(2);
    expect(requests[0]?.stdin).not.toContain('JSON形式エラーによる再試行');
    expect(requests[1]?.stdin).toContain('前回の回答はJSON.parseできない不正JSONでした');
    expect(requests[1]?.stdin).toContain(String.raw`\"`);
    expect(requests[1]?.stdin).toContain(
      'Markdownコードフェンス、説明文、見出し、注釈を付けず、有効なJSONオブジェクトだけ',
    );
    expect(requests[1]?.stdin).toContain('<UNTRUSTED_DOCUMENT>');
    expect(analyzer.getLastRunInfo()).toEqual({ jsonParseRetryCount: 1 });
  });

  it('初回のZod validation失敗では再試行しない', async () => {
    let calls = 0;
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => {
        calls += 1;
        return {
          stdout: JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            result: JSON.stringify({ is_target: true }),
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      },
    });

    await expect(analyzer.analyze(makeInput())).rejects.toThrow('stage 8');
    expect(calls).toBe(1);
    expect(analyzer.getLastRunInfo()).toEqual({ jsonParseRetryCount: 0 });
  });

  it('outer Claude CLI JSONのparse失敗では再試行しない', async () => {
    let calls = 0;
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => {
        calls += 1;
        return {
          stdout: 'not-outer-json',
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      },
    });

    await expect(analyzer.analyze(makeInput())).rejects.toThrow('stage 1');
    expect(calls).toBe(1);
    expect(analyzer.getLastRunInfo()).toEqual({ jsonParseRetryCount: 0 });
  });

  it('再試行後もJSON parse失敗なら2回で停止する', async () => {
    let calls = 0;
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => {
        calls += 1;
        return {
          stdout: JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            result: '{"quote":"unescaped "quote""}',
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      },
    });

    await expect(analyzer.analyze(makeInput())).rejects.toThrow(
      'JSON parse retry was attempted once but failed',
    );
    expect(calls).toBe(2);
    expect(analyzer.getLastRunInfo()).toEqual({ jsonParseRetryCount: 1 });
  });

  it('Claudeの外側JSONとresult文字列を順番に解析する', () => {
    expect(parseClaudeOutput(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\``,
    })).is_target).toBe(true);
    expect(() => parseClaudeOutput('not-json')).toThrow('outer JSON');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'assistant', subtype: 'success', is_error: false, result: '{}',
    }))).toThrow('stage 2');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'error', is_error: true, result: '{}',
    }))).toThrow('stage 3');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, result: '{}',
    }))).toThrow('stage 4');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: {},
    }))).toThrow('stage 5');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'not-json',
    }))).toThrow('stage 7');
    expect(() => parseClaudeOutput(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: JSON.stringify({ is_target: true }),
    }))).toThrow('stage 8');
  });

  it.each([
    ['json指定', (json: string) => `\`\`\`json\n${json}\n\`\`\``],
    ['言語指定なし', (json: string) => `\`\`\`\n${json}\n\`\`\``],
    ['CRLF・閉じフェンス前の空白', (json: string) => `\`\`\`json\r\n${json}\r\n  \`\`\``],
    ['前後の空白・改行', (json: string) => ` \n\n\`\`\`json\n${json}\n\`\`\`\n\n `],
  ])('result全体を囲む%sコードフェンスだけを除去する', (_label, fence) => {
    expect(parseClaudeOutput(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: fence(JSON.stringify(validAnalysis())),
    }))).toEqual(validAnalysis());
  });

  it('説明文付き・閉じフェンスなし・コードフェンス後の文章をstage 7にする', () => {
    const invalidResults = [
      `結果です。\n\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\``,
      `\`\`\`json\n${JSON.stringify(validAnalysis())}`,
      `\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\`\n追加の説明です。`,
    ];
    for (const result of invalidResults) {
      expect(() => parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }))).toThrow('stage 7');
    }
  });

  it('stage 7で文字数・fence状態・JSON.parseメッセージ・先頭末尾を表示する', () => {
    const result = `先頭です。${'a'.repeat(600)}中央は表示しない${'b'.repeat(600)}末尾です。`;

    try {
      parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }));
      throw new Error('Expected parseClaudeOutput to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Claude result parse diagnostics:');
      expect(message).toContain(`Result characters: ${Array.from(result).length}`);
      expect(message).toContain('Code fence detected: No');
      expect(message).toContain('Code fence removed: No');
      expect(message).toContain(`Prepared JSON characters: ${Array.from(result).length}`);
      expect(message).toMatch(/JSON\.parse error: .+/u);
      expect(message).toContain('Prepared JSON head (up to 500 characters):\n先頭です。aaa');
      expect(message).toContain('Prepared JSON tail (up to 500 characters):');
      expect(message).toContain('bbb末尾です。');
      expect(message).not.toContain('中央は表示しない');
    }
  });

  it('fence除去後の壊れたJSONで実際のparseエラーとfence診断を表示する', () => {
    const result = '\`\`\`json\n{"is_target": true,}\n\`\`\`';
    try {
      parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }));
      throw new Error('Expected parseClaudeOutput to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Code fence detected: Yes');
      expect(message).toContain('Code fence removed: Yes');
      expect(message).toContain('Prepared JSON characters: 20');
      expect(message).toMatch(/JSON\.parse error: .+/u);
      expect(message).toContain('{"is_target": true,}');
    }
  });

  it('JSON.parseのエラー位置前後200文字をcontextとして表示する', () => {
    const malformedJson = [
      '{"prefix":"',
      'あ'.repeat(260),
      '","valid":true ',
      '"tail":"',
      'い'.repeat(260),
      '"}',
    ].join('');
    const result = `\`\`\`json\n${malformedJson}\n\`\`\``;

    try {
      parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }));
      throw new Error('Expected parseClaudeOutput to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/JSON\.parse error: .*position \d+/u);
      expect(message).toContain('Parse error context (up to 200 characters before and after):');
      expect(message).toContain('<<< PARSE ERROR POSITION >>>');
      expect(message).toContain('あああ');
      expect(message).toContain('"tail":"いいい');
    }
  });

  it('コードフェンス後に文章がある場合は検出するが除去しない', () => {
    const result = `\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\`\n追加の説明です。`;
    try {
      parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }));
      throw new Error('Expected parseClaudeOutput to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Code fence detected: Yes');
      expect(message).toContain('Code fence removed: No');
      expect(message).toContain('追加の説明です。');
    }
  });

  it('stage 7の診断情報からtoken・APIキー・Bearer値を除去する', () => {
    const notionToken = 'secret_abcdefghijklmnopqrstuvwxyz123456';
    const anthropicKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    const bearerToken = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const result = [
      `NOTION_TOKEN=${notionToken}`,
      `ANTHROPIC_API_KEY: "${anthropicKey}"`,
      `Authorization: Bearer ${bearerToken}`,
      '前後の説明文',
    ].join('\n');

    try {
      parseClaudeOutput(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result,
      }));
      throw new Error('Expected parseClaudeOutput to fail.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Claude result parse diagnostics');
      expect(message).toContain('[REDACTED]');
      expect(message).not.toContain(notionToken);
      expect(message).not.toContain(anthropicKey);
      expect(message).not.toContain(bearerToken);
    }
  });

  it('正常なClaude resultの解析結果を変更しない', () => {
    const analysis = validAnalysis();
    expect(parseClaudeOutput(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(analysis),
    }))).toEqual(analysis);
  });

  it('Claude CLIの空出力を認証と決めつけず実行診断付きエラーにする', async () => {
    const analyzer = new ClaudeCliAnalyzer({
      executable: 'claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => ({
        stdout: '', stderr: 'diagnostic stderr', exitCode: 0, signal: null,
      }),
    });
    await expect(analyzer.analyze(makeInput())).rejects.toThrow(
      'exit=0, signal=none, stdoutCharacters=0',
    );
    await expect(analyzer.analyze(makeInput())).rejects.toThrow('diagnostic stderr');
  });

  it('Claude CLIの非0終了を終了コード・出力長・標準エラー全文付きで報告する', async () => {
    const analyzer = new ClaudeCliAnalyzer({
      executable: 'claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => ({
        stdout: 'partial',
        stderr: 'first line\nsecond line',
        exitCode: 7,
        signal: null,
      }),
    });
    await expect(analyzer.analyze(makeInput())).rejects.toThrow(
      'exit=7, signal=none, stdoutCharacters=7',
    );
    await expect(analyzer.analyze(makeInput())).rejects.toThrow('first line\nsecond line');
  });

  it('子プロセスをタイムアウトで終了する', async () => {
    await expect(runChildProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => undefined, 10000)'],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 20,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    })).rejects.toThrow(AiAnalyzerError);
  });

  it('子プロセスの非0終了コードと標準エラーを呼び出し側へ返す', async () => {
    const result = await runChildProcess({
      executable: process.execPath,
      args: ['-e', 'process.stderr.write("line 1\\nline 2"); process.exit(3)'],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 10_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: '',
      stderr: 'line 1\nline 2',
    });
  });
});

describe('HTML・PDF・AI連携', () => {
  it('PDFを重複除外・件数制限し、1件失敗してもHTMLでAI解析を続ける', async () => {
    let analyzerInput: AdministrativeNeedAnalysisInput | undefined;
    const analyzer = {
      provider: 'mock' as const,
      model: null,
      analyze: async (input: AdministrativeNeedAnalysisInput) => {
        analyzerInput = input;
        return validAnalysis();
      },
    };
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer,
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 2 },
    }, {
      extractContent: async () => makeDocument({
        pdfUrls: [PDF_A, `${PDF_A}#page=2`, PDF_B, PDF_C],
      }),
      extractPdf: async ({ url }) => {
        if (url === PDF_B) throw new Error('fixture PDF failure');
        return makePdf(url);
      },
    });

    expect(analyzerInput?.pdfDocuments).toHaveLength(1);
    expect(result.inputSummary).toMatchObject({
      pdfDiscovered: 3,
      pdfAttempted: 2,
      pdfIncluded: 1,
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('pdf_limit');
    expect(result.warnings.map((warning) => warning.code)).toContain('pdf_failed');
  });

  it('--no-pdfではPDF取得を行わない', async () => {
    let pdfCalled = false;
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: true,
      analyzer: new MockAnalyzer(),
      companyFitCriteria: fitCriteria(),
    }, {
      extractContent: async () => makeDocument({ pdfUrls: [PDF_A] }),
      extractPdf: async () => {
        pdfCalled = true;
        return makePdf(PDF_A);
      },
    });
    expect(pdfCalled).toBe(false);
    expect(result.inputSummary.pdfAttempted).toBe(0);
  });
});

describe('ai:checkコマンド', () => {
  it('--source、--url、--json、--no-pdfを解釈する', () => {
    expect(parseAiCheckArgs([
      '--source=osaka-digital-rss',
      `--url=${DOCUMENT_URL}`,
      '--json',
      '--no-pdf',
    ])).toEqual({
      sourceId: 'osaka-digital-rss',
      url: DOCUMENT_URL,
      json: true,
      noPdf: true,
    });
  });

  it('必須引数の欠落、重複、不正URLを拒否する', () => {
    expect(() => parseAiCheckArgs([])).toThrow('--source');
    expect(() => parseAiCheckArgs(['--source', 'source'])).toThrow('--url');
    expect(() => parseAiCheckArgs([
      '--source', 'source', '--url', DOCUMENT_URL, '--json', '--json',
    ])).toThrow('--json は1回');
    expect(() => parseAiCheckArgs([
      '--source', 'source', '--url', 'file:///tmp/document.html',
    ])).toThrow('http または https');
  });

  it('--jsonは解析JSONだけを標準出力し、Warningを標準エラーへ出す', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = makeAiCheckResult({
      warnings: [{ code: 'pdf_failed', message: 'PDF失敗' }],
    });
    const exitCode = await runAiCheck([
      '--source', 'source', '--url', DOCUMENT_URL, '--json',
    ], {
      env: { AI_PROVIDER: 'mock' },
      loadRegistry: async () => registry(),
      loadFitCriteria: async () => fitCriteria(),
      loadPrompt: async () => 'prompt',
      analyzerFactory: () => new MockAnalyzer(),
      checkNeed: async () => result,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[0] ?? '')).toEqual(result.analysis);
    expect(stdout[0]).not.toContain('inputSummary');
    expect(stderr.join('\n')).toContain('pdf_failed');
  });

  it('HTML取得などの実行失敗は終了コード1、情報源不明は2にする', async () => {
    const common = {
      env: { AI_PROVIDER: 'mock' },
      loadRegistry: async () => registry(),
      loadFitCriteria: async () => fitCriteria(),
      loadPrompt: async () => 'prompt',
      analyzerFactory: () => new MockAnalyzer(),
      stdout: () => undefined,
      stderr: () => undefined,
    };
    expect(await runAiCheck([
      '--source', 'source', '--url', DOCUMENT_URL,
    ], {
      ...common,
      checkNeed: async () => { throw new Error('HTML fixture failure'); },
    })).toBe(1);
    expect(await runAiCheck([
      '--source', 'missing', '--url', DOCUMENT_URL,
    ], common)).toBe(2);
  });

  it('通常表示に判定、入力件数、根拠照合数を含める', () => {
    const formatted = formatAiCheckResult(makeAiCheckResult());
    expect(formatted).toContain('Target: Yes');
    expect(formatted).toContain('Company relevance: A');
    expect(formatted).toContain('Evidence matched: 1/1');
    expect(formatted).toContain('PDF documents: 0/0');
  });
});

function validAnalysis(
  overrides: Partial<AdministrativeNeedAnalysis> = {},
): AdministrativeNeedAnalysis {
  return {
    is_target: true,
    document_type: 'rfi',
    problem_summary: '行政サービスを利用者視点で改善する知見が不足している。',
    desired_state: '利用者視点で継続的に改善できる状態。',
    request_to_private_sector: 'サービスデザインの手法と事例に関する情報提供。',
    categories: ['行政DX', 'UI・UX'],
    company_relevance: 'A',
    contact_recommendation: 'high',
    reason: '情報提供依頼段階で対話の余地がある。',
    evidence_quotes: [{
      source_type: 'html',
      source_url: DOCUMENT_URL,
      quote: '行政サービスを改善するための情報提供を募集します。',
    }],
    ...overrides,
  };
}

function fitCriteria(): CompanyFitCriteria {
  return {
    version: 1,
    name: '自社',
    directFit: ['Webサイト構築'],
    partnerFit: ['大規模システム開発'],
    strategicInterest: ['Webサイト刷新の構想段階'],
    outOfScope: ['物品購入'],
  };
}

function makeInput(
  overrides: Partial<AdministrativeNeedAnalysisInput> = {},
): AdministrativeNeedAnalysisInput {
  return {
    title: '情報提供依頼',
    officialUrl: DOCUMENT_URL,
    organizationName: '大阪市',
    sourceName: 'デジタル統括室 RSS',
    htmlText: '行政サービスを改善するための情報提供を募集します。\n追加本文です。',
    pdfDocuments: [],
    companyFitCriteria: fitCriteria(),
    ...overrides,
  };
}

function basePrepareOptions() {
  return {
    title: '情報提供依頼',
    officialUrl: DOCUMENT_URL,
    organizationName: '大阪市',
    sourceName: 'デジタル統括室 RSS',
    htmlText: '行政サービスを改善するための情報提供を募集します。',
    pdfDocuments: [],
    pdfDiscovered: 0,
    pdfAttempted: 0,
    companyFitCriteria: fitCriteria(),
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source',
    organization_id: 'osaka-city',
    name: 'デジタル統括室 RSS',
    url: 'https://www.city.osaka.lg.jp/rss.xml',
    collector_type: 'rss',
    source_category: 'digital_news',
    priority: 'high',
    enabled: true,
    content_selector: 'main',
    ...overrides,
  };
}

function makeOrganization(): Organization {
  return {
    id: 'osaka-city',
    name: '大阪市',
    organization_type: 'designated_city',
    official_domain: 'city.osaka.lg.jp',
    enabled: true,
  };
}

function registry(): SourceRegistry {
  return { version: 1, organizations: [makeOrganization()], sources: [makeSource()] };
}

function makeDocument(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const bodyText = '行政サービスを改善するための情報提供を募集します。'.repeat(20);
  return {
    sourceId: 'source',
    sourceEnabled: true,
    requestedUrl: DOCUMENT_URL,
    url: DOCUMENT_URL,
    httpStatus: 200,
    contentType: 'text/html',
    responseBytes: 2_000,
    durationMs: 1,
    redirectCount: 0,
    title: '情報提供依頼',
    bodyText,
    bodyLength: bodyText.length,
    publishedAtCandidate: '2026-08-06',
    publishedAtSource: 'time',
    pdfUrls: [],
    // pdfUrls だけを上書きするテストのために、未指定なら pdfUrls から導出する。
    pdfLinks: (overrides.pdfUrls ?? []).map((url) => ({ url, text: '' })),
    contentSelectorConfigured: 'main',
    contentSelectorUsed: 'main',
    usedFallback: false,
    warnings: [],
    ...overrides,
  };
}

function makePdf(url: string): ExtractedPdf {
  const text = 'PDFから抽出した本文です。';
  return {
    parser: 'unpdf',
    pageCount: 1,
    pageTexts: [text],
    text,
    characterCount: text.length,
    pagesWithText: 1,
    emptyPageCount: 0,
    warnings: [],
    sourceId: 'source',
    sourceEnabled: true,
    requestedUrl: url,
    url,
    httpStatus: 200,
    contentType: 'application/pdf',
    responseBytes: 1_000,
    durationMs: 1,
    redirectCount: 0,
  };
}

function makeAiCheckResult(overrides: Partial<AiCheckResult> = {}): AiCheckResult {
  return {
    sourceId: 'source',
    sourceName: 'デジタル統括室 RSS',
    organizationName: '大阪市',
    title: '情報提供依頼',
    requestedUrl: DOCUMENT_URL,
    officialUrl: DOCUMENT_URL,
    provider: 'mock',
    model: null,
    analysis: validAnalysis(),
    inputSummary: {
      htmlOriginalCharacters: 500,
      htmlSentCharacters: 500,
      pdfDiscovered: 0,
      pdfAttempted: 0,
      pdfIncluded: 0,
      pdfOriginalCharacters: 0,
      pdfSentCharacters: 0,
    },
    evidenceMatched: 1,
    warnings: [],
    ...overrides,
  };
}
