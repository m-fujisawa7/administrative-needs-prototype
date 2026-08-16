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
import { pdfContentFingerprint } from '../src/ai/pdf-duplicates.ts';
import {
  formatAnalysisInput,
  loadAiCheckPrompt,
  renderAiCheckPrompt,
} from '../src/ai/prompt.ts';
import { runChildProcess, type ChildProcessRequest } from '../src/ai/process.ts';
import { warningSeverity } from '../src/ai/warning-severity.ts';
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
import { PdfCheckError, type ExtractedPdf } from '../src/pdf-check/types.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../src/source-registry/schema.ts';

const DOCUMENT_URL = 'https://www.city.osaka.lg.jp/page/document.html';
const PDF_A = 'https://www.city.osaka.lg.jp/files/a.pdf';
const PDF_B = 'https://www.city.osaka.lg.jp/files/b.pdf';
const PDF_C = 'https://www.city.osaka.lg.jp/files/c.pdf';
const PDF_D = 'https://www.city.osaka.lg.jp/files/d.pdf';
const PDF_E = 'https://www.city.osaka.lg.jp/files/e.pdf';

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

  it('Claudeへ渡す原文の内訳と合計をsummaryに残す', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      htmlText: 'H'.repeat(1_805),
      pdfDocuments: [
        { url: PDF_A, text: 'A'.repeat(12_400) },
        { url: PDF_B, text: 'B'.repeat(6_020) },
      ],
      pdfLabels: ['基本仕様書', '公募実施要領'],
      pdfSkipped: [
        { label: '評価基準', url: PDF_C },
        { label: '様式1 参加申込書', url: `${PDF_C}?v=2` },
      ],
      pdfDiscovered: 4,
      pdfAttempted: 2,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });
    expect(prepared.summary.htmlSentCharacters).toBe(1_805);
    expect(prepared.summary.pdfSentCharacters).toBe(18_420);
    expect(prepared.summary.totalSourceCharacters).toBe(20_225);
    expect(prepared.summary.pdfInputs).toEqual([
      { label: '基本仕様書', url: PDF_A, characters: 12_400, extractedCharacters: 12_400, strategy: 'full', chunkCount: 1 },
      { label: '公募実施要領', url: PDF_B, characters: 6_020, extractedCharacters: 6_020, strategy: 'full', chunkCount: 1 },
    ]);
    expect(prepared.summary.pdfSkipped.map((pdf) => pdf.label))
      .toEqual(['評価基準', '様式1 参加申込書']);
  });

  it('切り詰めが起きたときpdfInputsは送信後の文字数を持つ', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: 'A'.repeat(80) },
        { url: PDF_B, text: 'B'.repeat(80) },
      ],
      pdfLabels: ['仕様書', '実施要領'],
      pdfDiscovered: 2,
      pdfAttempted: 2,
      limits: { htmlCharacters: 1_000, pdfCharacters: 60, maxPdfs: 3 },
    });
    expect(prepared.summary.pdfInputs.map((pdf) => pdf.characters)).toEqual([30, 30]);
    expect(prepared.summary.pdfSentCharacters).toBe(60);
  });

  it('PDFなしcandidateでは内訳が空で合計はHTMLだけになる', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      htmlText: 'H'.repeat(742),
      pdfDocuments: [],
      pdfDiscovered: 0,
      pdfAttempted: 0,
    });
    expect(prepared.summary.pdfInputs).toEqual([]);
    expect(prepared.summary.pdfSkipped).toEqual([]);
    expect(prepared.summary.totalSourceCharacters).toBe(742);
  });

  it('ラベルが渡されない場合はファイル名を内訳ラベルに使う', () => {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [{ url: PDF_A, text: 'A'.repeat(10) }],
      pdfDiscovered: 1,
      pdfAttempted: 1,
    });
    expect(prepared.summary.pdfInputs[0]?.label).toBe('a.pdf');
  });

  /** 見出し付きの長大PDFをページ配列で作る。 */
  function specPages(count: number, length = 900): string[] {
    return Array.from({ length: count }, (_v, index) => {
      const heading = index % 2 === 0 ? `${index + 1} 業務内容` : `${index + 1} 参加資格`;
      const body = index % 2 === 0
        ? '受注者は窓口対応と入力処理を行う。機能要件は別紙のとおり。'
        : '提出書類は様式第1号による。評価基準は採点表による。';
      const filler = body.repeat(Math.ceil(length / body.length));
      return `${heading}\n${filler.slice(0, length - heading.length - 1)}`;
    });
  }

  it('複数PDFでも各PDFの割り当てbudget内でRelevant選択する', () => {
    const huge = specPages(60);
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: huge.join('\n\n') },
        { url: PDF_B, text: 'B'.repeat(8_000) },
        { url: PDF_C, text: 'C'.repeat(4_000) },
      ],
      pdfPageTexts: [huge, undefined as unknown as string[], undefined as unknown as string[]],
      pdfLabels: ['長大仕様書', '実施要領', '公募要領'],
      pdfDiscovered: 3,
      pdfAttempted: 3,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });
    const [first, second, third] = prepared.summary.pdfInputs;
    // 巨大PDFは1件上限20,000以内で選択され、短い2件は全文のまま残る。
    expect(first?.characters).toBeLessThanOrEqual(20_000);
    expect(first?.strategy).toBe('relevant_chunks');
    expect(second).toMatchObject({ characters: 8_000, strategy: 'full' });
    expect(third).toMatchObject({ characters: 4_000, strategy: 'full' });
    expect(prepared.summary.pdfSentCharacters).toBeLessThanOrEqual(50_000);
  });

  it('Relevant選択後に70/30で再切り詰めしない', () => {
    const huge = specPages(60);
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [{ url: PDF_A, text: huge.join('\n\n') }],
      pdfPageTexts: [huge],
      pdfDiscovered: 1,
      pdfAttempted: 1,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });
    const sent = prepared.input.pdfDocuments[0]!.text;
    // 70/30切り詰めは中央に省略マーカーを1つだけ入れる。Relevant選択の結果は
    // ブロック数に応じた区切りになるため、選択が上書きされていないことを見る。
    expect(prepared.summary.pdfInputs[0]?.strategy).toBe('relevant_chunks');
    expect(sent).toContain('業務内容');
    expect(sent.length).toBeLessThanOrEqual(20_000);
  });

  it('3PDF合計が上限を超える場合も各budget内で選択する', () => {
    const pagesOf = (count: number) => specPages(count);
    const a = pagesOf(40);
    const b = pagesOf(40);
    const c = pagesOf(40);
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: a.join('\n\n') },
        { url: PDF_B, text: b.join('\n\n') },
        { url: PDF_C, text: c.join('\n\n') },
      ],
      pdfPageTexts: [a, b, c],
      pdfDiscovered: 3,
      pdfAttempted: 3,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });
    expect(prepared.summary.pdfSentCharacters).toBeLessThanOrEqual(50_000);
    for (const pdf of prepared.summary.pdfInputs) {
      expect(pdf.characters).toBeLessThanOrEqual(20_000);
    }
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

  it('PDF合計が上限内でも1件上限を超えるPDFだけは切り詰める', () => {
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
    // 合計36,655は50,000以内だが、31,731のPDFは1件上限20,000へ収める。
    expect(prepared.input.pdfDocuments.map((document) => document.text.length))
      .toEqual([20_000, 4_924]);
    expect(prepared.summary.pdfSentCharacters).toBe(24_924);
    expect(prepared.warnings.map((warning) => warning.code)).toContain('pdf_truncated');
  });

  /** 指定した文字数のPDFを渡し、実際に送信された文字数を返す。 */
  function allocate(lengths: number[], pdfCharacters = 50_000) {
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: lengths.map((length, index) => ({
        url: `https://www.city.osaka.lg.jp/files/${index}.pdf`,
        text: String(index).repeat(length),
      })),
      pdfDiscovered: lengths.length,
      pdfAttempted: lengths.length,
      limits: { htmlCharacters: 30_000, pdfCharacters, maxPdfs: 3 },
    });
    return {
      sent: prepared.input.pdfDocuments.map((document) => document.text.length),
      total: prepared.summary.pdfSentCharacters,
      warnings: prepared.warnings,
      prepared,
    };
  }

  it('1PDFあたりの上限で長大PDF1件の予算独占を防ぐ', () => {
    const result = allocate([49_846]);
    expect(result.sent[0]).toBe(20_000);
    expect(result.total).toBe(20_000);
  });

  it('短いPDFは1PDFあたり上限に関係なく全文を使う', () => {
    const result = allocate([9_681, 7_708, 4_037]);
    expect(result.sent).toEqual([9_681, 7_708, 4_037]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('pdf_truncated');
  });

  it('巨大PDF1件があっても他のPDFの取り分を残す', () => {
    const result = allocate([49_846, 8_000, 4_000]);
    expect(result.sent).toEqual([20_000, 8_000, 4_000]);
    expect(result.total).toBe(32_000);
  });

  it('1PDFあたり上限を環境変数で変更できる', () => {
    expect(aiInputLimitsFromEnvironment({ AI_MAX_CHARACTERS_PER_PDF: '25000' }))
      .toMatchObject({ charactersPerPdf: 25_000 });
    expect(aiInputLimitsFromEnvironment({})).toMatchObject({ charactersPerPdf: 20_000 });
    expect(() => aiInputLimitsFromEnvironment({ AI_MAX_CHARACTERS_PER_PDF: '999' })).toThrow();
  });

  it('PDF1件で上限を超えても合計上限と1件上限の両方に収める', () => {
    const result = allocate([60_000]);
    expect(result.total).toBeLessThanOrEqual(50_000);
    expect(result.sent[0]).toBe(20_000);
  });

  it('PDF2件で上限を超えても両方が入力に含まれる', () => {
    const result = allocate([40_000, 30_000]);
    // 1件上限20,000を各PDFへ当てるため合計は40,000に収まる。
    expect(result.total).toBe(40_000);
    expect(result.sent).toEqual([20_000, 20_000]);
  });

  it('PDF3件で上限を超えても3件すべてが入力に含まれる', () => {
    const result = allocate([30_000, 20_000, 15_000]);
    expect(result.sent).toEqual([17_500, 17_500, 15_000]);
    expect(result.total).toBe(50_000);
  });

  it('均等枠より短いPDFは全文使用し、余った予算を他へ再配分する', () => {
    // 均等枠は 50000/3 = 16666。15000文字のPDFは全文使い、余りが他2件へ回る。
    const result = allocate([30_000, 20_000, 15_000]);
    expect(result.sent[2]).toBe(15_000);
    expect(result.sent[0]).toBeGreaterThan(16_666);
    expect(result.sent[1]).toBeGreaterThan(16_666);
  });

  it('極端に偏っていても短いPDFが落ちない', () => {
    const result = allocate([49_999, 1, 1]);
    expect(result.sent).toEqual([20_000, 1, 1]);
    expect(result.total).toBe(20_002);
  });

  it('どのPDFも均等枠に収まらない場合は均等配分し端数を配る', () => {
    const result = allocate([50_000, 50_000, 50_000]);
    expect(result.sent).toEqual([16_667, 16_667, 16_666]);
    expect(result.total).toBe(50_000);
  });

  it('最終合計が上限を超えない', () => {
    for (const lengths of [[60_000], [40_000, 30_000], [30_000, 20_000, 15_000], [50_000, 50_000, 50_000]]) {
      expect(allocate(lengths).total, lengths.join('/')).toBeLessThanOrEqual(50_000);
    }
  });

  it('同じ入力なら毎回同じ配分になる', () => {
    const first = allocate([30_000, 20_000, 15_000]).sent;
    for (let i = 0; i < 5; i += 1) {
      expect(allocate([30_000, 20_000, 15_000]).sent).toEqual(first);
    }
  });

  it('PDFなしでも既存どおり動作する', () => {
    const result = allocate([]);
    expect(result.sent).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('pdf_truncated');
  });

  it('上限以内の1〜3件は全文のまま既存挙動を変えない', () => {
    for (const lengths of [[10_000], [10_000, 10_000], [10_000, 10_000, 10_000]]) {
      const result = allocate(lengths);
      expect(result.sent, lengths.join('/')).toEqual(lengths);
      expect(result.warnings.map((warning) => warning.code)).not.toContain('pdf_truncated');
    }
  });

  it('切り詰め時のWarningに各PDFの使用文字数を含める', () => {
    const warning = allocate([30_000, 20_000, 15_000]).warnings
      .find((entry) => entry.code === 'pdf_truncated');
    expect(warning?.message).toContain('65000 文字から 50000 文字');
    expect(warning?.message).toContain('0.pdf 30000→17500');
    expect(warning?.message).toContain('1.pdf 20000→17500');
    expect(warning?.message).toContain('2.pdf 15000→15000');
  });

  it('Evidence照合はAIへ渡した切り詰め後のテキストを対象にする', () => {
    // truncateHeadTail は先頭と末尾を残して中間を落とすため、
    // 残る先頭と、落ちる中間の両方に目印を置いて確認する。
    const head = '先頭に必ず残る文言';
    const middle = '中間にしかない文言';
    const prepared = prepareAnalysisInput({
      ...basePrepareOptions(),
      pdfDocuments: [
        { url: PDF_A, text: `${head}${'あ'.repeat(60_000)}` },
        { url: PDF_B, text: `${'い'.repeat(25_000)}${middle}${'う'.repeat(25_000)}` },
      ],
      pdfDiscovered: 2,
      pdfAttempted: 2,
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    });

    const sentA = prepared.input.pdfDocuments[0]?.text ?? '';
    expect(sentA).toContain(head);
    expect(validateEvidenceQuotes(validAnalysis({
      evidence_quotes: [{ source_type: 'pdf', source_url: PDF_A, quote: head }],
    }), prepared.input).matched).toBe(1);

    // AIへ渡していない範囲の文字列は一致扱いにしない。
    const sentB = prepared.input.pdfDocuments[1]?.text ?? '';
    expect(sentB).not.toContain(middle);
    const notSent = validateEvidenceQuotes(validAnalysis({
      evidence_quotes: [{ source_type: 'pdf', source_url: PDF_B, quote: middle }],
    }), prepared.input);
    expect(notSent.matched).toBe(0);
    expect(notSent.warnings[0]?.code).toBe('evidence_not_found');
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

  it('外側JSONにusageがあれば入力トークン数をrunInfoへ残す', async () => {
    const analyzer = new ClaudeCliAnalyzer({
      executable: '/path/to/claude',
      timeoutMs: 10_000,
      systemPrompt: 'system prompt',
      runner: async () => ({
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify(validAnalysis()),
          usage: { input_tokens: 12_345, output_tokens: 678 },
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
      }),
    });
    await analyzer.analyze(makeInput());
    expect(analyzer.getLastRunInfo()).toMatchObject({ inputTokens: 12_345 });
  });

  it('usageが無い、または型が違う場合はinputTokensを持たない', async () => {
    for (const envelope of [
      { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(validAnalysis()) },
      {
        type: 'result', subtype: 'success', is_error: false,
        result: JSON.stringify(validAnalysis()),
        usage: { input_tokens: 'many' },
      },
    ]) {
      const analyzer = new ClaudeCliAnalyzer({
        executable: '/path/to/claude',
        timeoutMs: 10_000,
        systemPrompt: 'system prompt',
        runner: async () => ({
          stdout: JSON.stringify(envelope), stderr: '', exitCode: 0, signal: null,
        }),
      });
      await analyzer.analyze(makeInput());
      expect(analyzer.getLastRunInfo().inputTokens).toBeUndefined();
    }
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

  it('低優先PDFを取得せず、外した資料をsummaryへ残す', async () => {
    const fetched: string[] = [];
    let analyzerInput: AdministrativeNeedAnalysisInput | undefined;
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: {
        provider: 'mock',
        model: null,
        analyze: async (input: AdministrativeNeedAnalysisInput) => {
          analyzerInput = input;
          return validAnalysis();
        },
      },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '基本仕様書' },
          { url: PDF_B, text: '評価基準' },
          { url: PDF_C, text: '様式1 参加申込書' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        return makePdf(url);
      },
    });

    // 低優先PDFは取得自体を行わないため、AI入力だけでなくPDF取得の通信も減る。
    expect(fetched).toEqual([PDF_A]);
    expect(analyzerInput?.pdfDocuments.map((pdf) => pdf.url)).toEqual([PDF_A]);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['基本仕様書']);
    expect(result.inputSummary.pdfSkipped.map((pdf) => pdf.label))
      .toEqual(['評価基準', '様式1 参加申込書']);
    expect(result.inputSummary.totalSourceCharacters)
      .toBe(result.inputSummary.htmlSentCharacters + result.inputSummary.pdfSentCharacters);
  });

  it('低優先PDFしか無いcandidateではPDFを捨てず従来どおり解析する', async () => {
    const fetched: string[] = [];
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '評価基準' },
          { url: PDF_B, text: '様式1 参加申込書' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        return makePdf(url);
      },
    });

    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    expect(result.inputSummary.pdfSkipped).toEqual([]);
    // 除外していないので既存のpdf_limit通知は出ない。
    expect(result.warnings.map((warning) => warning.code)).not.toContain('pdf_limit');
  });

  it('低優先PDFを外した場合も既存のpdf_limit通知で件数と採用資料を示す', async () => {
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '業務仕様書' },
          { url: PDF_B, text: '審査基準' },
          { url: PDF_C, text: '委任状' },
        ],
      }),
      extractPdf: async ({ url }) => makePdf(url),
    });

    const limit = result.warnings.find((warning) => warning.code === 'pdf_limit');
    expect(limit?.message).toContain('検出したPDF 3件');
    expect(limit?.message).toContain('1件を解析します');
    expect(limit?.message).toContain('業務仕様書');
  });

  it('低優先PDFを外してもHTML本文はそのままClaudeへ渡す', async () => {
    let analyzerInput: AdministrativeNeedAnalysisInput | undefined;
    const body = '行政課題の本文'.repeat(50);
    await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: {
        provider: 'mock',
        model: null,
        analyze: async (input: AdministrativeNeedAnalysisInput) => {
          analyzerInput = input;
          return validAnalysis();
        },
      },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        bodyText: body,
        pdfLinks: [
          { url: PDF_A, text: '仕様書' },
          { url: PDF_B, text: '評価基準' },
        ],
      }),
      extractPdf: async ({ url }) => makePdf(url),
    });

    expect(analyzerInput?.htmlText).toBe(body);
  });

  it('本文0文字のPDFはAI入力枠を消費せず、次順位の候補を試す', async () => {
    const fetched: string[] = [];
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 2 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '別記仕様書' },
          { url: PDF_B, text: '公告文' },
          { url: PDF_C, text: '入札説明書' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        // 画像PDFを模して先頭候補だけ本文が空になる。
        return url === PDF_A ? { ...makePdf(url), text: '   \n ' } : makePdf(url);
      },
    });

    expect(fetched).toEqual([PDF_A, PDF_B, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['公告文', '入札説明書']);
    expect(result.warnings.map((warning) => warning.code)).toContain('pdf_empty_text');
  });

  it('有効PDFが上限に達したら残りの候補を取得しない', async () => {
    const fetched: string[] = [];
    await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 2 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '仕様書' },
          { url: PDF_B, text: '実施要領' },
          { url: PDF_C, text: '業務概要' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        return makePdf(url);
      },
    });

    expect(fetched).toEqual([PDF_A, PDF_B]);
  });

  it('全PDFが0文字でも解析を続け、既存のempty_pages警告を残す', async () => {
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '仕様書' },
          { url: PDF_B, text: '実施要領' },
        ],
      }),
      extractPdf: async ({ url }) => ({
        ...makePdf(url),
        text: '',
        pageTexts: [''],
        characterCount: 0,
        pagesWithText: 0,
        emptyPageCount: 1,
        warnings: [{ code: 'empty_pages', message: 'テキストを抽出できないページが1件あります。' }],
      }),
    });

    expect(result.inputSummary.pdfIncluded).toBe(0);
    expect(result.inputSummary.pdfInputs).toEqual([]);
    expect(result.analysis.is_target).toBe(true);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain('pdf_warning');
    expect(codes).toContain('pdf_empty_text');
    expect(result.warnings.find((warning) => warning.code === 'pdf_warning')?.detail)
      .toBe('empty_pages');
  });

  it('抽出失敗は従来どおりAI入力枠を消費し、補充で余分に取得しない', async () => {
    const fetched: string[] = [];
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 2 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '仕様書' },
          { url: PDF_B, text: '実施要領' },
          { url: PDF_C, text: '業務概要' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        if (url === PDF_B) throw new Error('fixture PDF failure');
        return makePdf(url);
      },
    });

    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toContain('pdf_failed');
  });

  it('パスワード保護PDFはAI入力枠を消費せず、次順位の候補を試す', async () => {
    const fetched: string[] = [];
    let analyzerInput: AdministrativeNeedAnalysisInput | undefined;
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: {
        provider: 'mock',
        model: null,
        analyze: async (input: AdministrativeNeedAnalysisInput) => {
          analyzerInput = input;
          return validAnalysis();
        },
      },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 1 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '別記仕様書' },
          { url: PDF_B, text: '公告文' },
        ],
      }),
      extractPdf: async ({ url }) => {
        fetched.push(url);
        if (url === PDF_A) throw passwordProtectedError();
        return makePdf(url);
      },
    });

    // 上限1件でも、パスワード保護は枠を消費しないので次候補まで進む。
    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(analyzerInput?.pdfDocuments.map((pdf) => pdf.url)).toEqual([PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['公告文']);
  });

  it('パスワード保護PDFはAI入力件数に含めず、WARNINGとして残す', async () => {
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [{ url: PDF_A, text: '別記仕様書' }],
      }),
      extractPdf: async () => {
        throw passwordProtectedError();
      },
    });

    expect(result.inputSummary.pdfIncluded).toBe(0);
    expect(result.inputSummary.pdfInputs).toEqual([]);
    expect(result.inputSummary.pdfSkipped.map((pdf) => pdf.label)).toEqual(['別記仕様書']);
    const failure = result.warnings.find((warning) => warning.code === 'pdf_failed');
    expect(failure?.detail).toBe('password_protected');
    expect(failure?.message).toContain('パスワード');
    // WARNING のままにする（NOTICEへ格下げしない）。
    expect(warningSeverity(failure!)).toBe('warning');
  });

  it('パスワード保護PDFしか無くても解析を続ける', async () => {
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs: 3 },
    }, {
      extractContent: async () => makeDocument({
        pdfLinks: [
          { url: PDF_A, text: '仕様書' },
          { url: PDF_B, text: '実施要領' },
        ],
      }),
      extractPdf: async () => {
        throw passwordProtectedError();
      },
    });

    expect(result.analysis.is_target).toBe(true);
    expect(result.inputSummary.pdfIncluded).toBe(0);
    expect(result.warnings.filter((warning) => warning.code === 'pdf_failed')).toHaveLength(2);
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

describe('PDF本文のfingerprint', () => {
  const BODY = '福岡市ＤＸ戦略 第１章 趣旨・目的 デジタル技術で市民生活を向上させる。';

  it('完全に同じ本文は同じfingerprintになる', () => {
    expect(pdfContentFingerprint(BODY)).toBe(pdfContentFingerprint(BODY));
  });

  it('前後の空白差を吸収する', () => {
    expect(pdfContentFingerprint(`  \n${BODY}\n\t `)).toBe(pdfContentFingerprint(BODY));
  });

  it('改行の差を吸収する', () => {
    expect(pdfContentFingerprint('第１章\n趣旨')).toBe(pdfContentFingerprint('第１章\n\n\n趣旨'));
    expect(pdfContentFingerprint('第１章\r\n趣旨')).toBe(pdfContentFingerprint('第１章 趣旨'));
  });

  it('連続空白の差を吸収する', () => {
    expect(pdfContentFingerprint('第１章    趣旨')).toBe(pdfContentFingerprint('第１章 趣旨'));
  });

  it('福岡型の日本語文字間空白の差を吸収する', () => {
    // 本編と印刷用の差は空白だけだった。全角スペースも \s に含まれる。
    expect(pdfContentFingerprint('福 岡 市 Ｄ Ｘ 戦 略')).toBe(pdfContentFingerprint('福 岡 市 Ｄ Ｘ 戦 略'));
    expect(pdfContentFingerprint('福岡市　ＤＸ戦略')).toBe(pdfContentFingerprint('福岡市 ＤＸ戦略'));
  });

  it('非空白文字が1文字でも違えば別のfingerprintになる', () => {
    expect(pdfContentFingerprint('第１章 趣旨')).not.toBe(pdfContentFingerprint('第２章 趣旨'));
    expect(pdfContentFingerprint(BODY)).not.toBe(pdfContentFingerprint(`${BODY}。`));
  });

  it('NFKC正規化はしないので全角と半角は別扱いにする', () => {
    // 令和6年度版と令和６年度版のような版違いを同一視しないため、
    // 実測で不要だったNFKCは適用しない。
    expect(pdfContentFingerprint('ＤＸ推進計画')).not.toBe(pdfContentFingerprint('DX推進計画'));
    expect(pdfContentFingerprint('令和6年度')).not.toBe(pdfContentFingerprint('令和６年度'));
  });

  it('広島の3計画のような別文書は別のfingerprintになる', () => {
    const plan2 = '第２期広島市ＤＸ推進計画 広島市 令和８年３月 目次 Ⅰ 計画の趣旨';
    const revised = '広島市デジタル・トランスフォーメーション（ＤＸ）推進計画 （令和６年度改定版）';
    const status = '広島市デジタル・トランスフォーメーション（ＤＸ）推進計画の 令和６年度取組状況一覧';
    const prints = [plan2, revised, status].map(pdfContentFingerprint);
    expect(new Set(prints).size).toBe(3);
  });
});

describe('内容が重複するPDFの扱い', () => {
  const DUPLICATE_TEXT = '福岡市ＤＸ戦略の本文です。趣旨・目的と実行項目を記載しています。';

  /** 指定URLだけ同じ本文を返す。それ以外はURLごとに異なる既定本文になる。 */
  const sharedTextFor = (...urls: readonly string[]) =>
    async ({ url }: { url: string }) =>
      (urls.includes(url) ? makePdf(url, DUPLICATE_TEXT) : makePdf(url));

  const run = async (
    pdfLinks: ReadonlyArray<{ url: string; text: string }>,
    extractPdf: (input: { url: string }) => Promise<ExtractedPdf>,
    maxPdfs = 2,
  ): Promise<{ result: AiCheckResult; fetched: string[] }> => {
    const fetched: string[] = [];
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs },
    }, {
      extractContent: async () => makeDocument({ pdfLinks: [...pdfLinks] }),
      extractPdf: async (input) => {
        fetched.push(input.url);
        return extractPdf(input);
      },
    });
    return { result, fetched };
  };

  it('重複PDFはAI入力枠を消費せず、次候補をrefillする', async () => {
    // 福岡と同じ並び。本編と印刷用が同一本文で、3件目に実行項目集がある。
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '福岡市DX戦略（本編）' },
        { url: PDF_B, text: '印刷用はこちら' },
        { url: PDF_C, text: '福岡市DX戦略 実行項目集' },
      ],
      sharedTextFor(PDF_A, PDF_B),
    );

    expect(fetched).toEqual([PDF_A, PDF_B, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label))
      .toEqual(['福岡市DX戦略（本編）', '福岡市DX戦略 実行項目集']);
  });

  it('先に現れたPDFを残す', async () => {
    const { result } = await run(
      [
        { url: PDF_A, text: '福岡市DX戦略（本編）' },
        { url: PDF_B, text: '印刷用はこちら' },
      ],
      sharedTextFor(PDF_A, PDF_B),
    );
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['福岡市DX戦略（本編）']);
  });

  it('重複PDFはAI入力に含めず、pdfSkippedへ入れる', async () => {
    const { result } = await run(
      [
        { url: PDF_A, text: '福岡市DX戦略（本編）' },
        { url: PDF_B, text: '印刷用はこちら' },
      ],
      sharedTextFor(PDF_A, PDF_B),
    );
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.url)).not.toContain(PDF_B);
    expect(result.inputSummary.pdfSkipped?.map((pdf) => pdf.url)).toContain(PDF_B);
  });

  it('pdf_duplicateをNOTICEとして出し、採用済みPDFが分かる文言にする', async () => {
    const { result } = await run(
      [
        { url: PDF_A, text: '福岡市DX戦略（本編）' },
        { url: PDF_B, text: '印刷用はこちら' },
      ],
      sharedTextFor(PDF_A, PDF_B),
    );
    const duplicate = result.warnings.find((warning) => warning.code === 'pdf_duplicate');
    expect(duplicate).toBeDefined();
    expect(warningSeverity(duplicate!)).toBe('notice');
    expect(duplicate!.message).toContain('福岡市DX戦略（本編）');
    expect(duplicate!.message).toContain(PDF_B);
  });

  it('重複が無ければ従来どおり全件を採用する', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '別記仕様書' },
        { url: PDF_B, text: '公告文' },
      ],
      async ({ url }) => makePdf(url),
    );
    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('pdf_duplicate');
  });

  it('本文0文字PDFと混在しても、0文字の既存挙動を壊さない', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '画像PDF' },
        { url: PDF_B, text: '福岡市DX戦略（本編）' },
        { url: PDF_C, text: '印刷用はこちら' },
      ],
      async ({ url }) => (url === PDF_A
        ? { ...makePdf(url), text: '   \n ' }
        : makePdf(url, DUPLICATE_TEXT)),
    );

    // 0文字も重複もどちらも枠を消費しないので、3件すべて取得を試す。
    expect(fetched).toEqual([PDF_A, PDF_B, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['福岡市DX戦略（本編）']);
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain('pdf_empty_text');
    expect(codes).toContain('pdf_duplicate');
  });

  it('パスワード保護PDFと混在しても、既存のrefillを壊さない', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '別記仕様書' },
        { url: PDF_B, text: '福岡市DX戦略（本編）' },
        { url: PDF_C, text: '印刷用はこちら' },
      ],
      async ({ url }) => {
        if (url === PDF_A) {
          throw new PdfCheckError('password_protected', 'PDFがパスワード保護されています。');
        }
        return makePdf(url, DUPLICATE_TEXT);
      },
    );

    expect(fetched).toEqual([PDF_A, PDF_B, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    const duplicate = result.warnings.find((warning) => warning.code === 'pdf_duplicate');
    expect(duplicate?.message).toContain(PDF_C);
    expect(result.warnings.some((warning) => warning.detail === 'password_protected')).toBe(true);
  });

  it('その他のPDF取得失敗と混在しても、失敗が枠を消費する既存仕様を変えない', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '別記仕様書' },
        { url: PDF_B, text: '福岡市DX戦略（本編）' },
        { url: PDF_C, text: '印刷用はこちら' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw new Error('fixture fetch failure');
        return makePdf(url, DUPLICATE_TEXT);
      },
    );

    // PDF_A の失敗が1枠、PDF_B の採用で1枠。maxPdfs=2 に達するので PDF_C は取得しない。
    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    expect(result.warnings.some((warning) => warning.code === 'pdf_failed')).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'pdf_duplicate')).toBe(false);
  });
});

describe('テキストレイヤーが無いPDFの扱い', () => {
  const noTextError = (): PdfCheckError => new PdfCheckError(
    'no_text',
    'PDFからテキストを抽出できませんでした。画像PDF・スキャンPDFの可能性があります。',
  );

  const run = async (
    pdfLinks: ReadonlyArray<{ url: string; text: string }>,
    extractPdf: (input: { url: string }) => Promise<ExtractedPdf>,
    maxPdfs = 2,
  ): Promise<{ result: AiCheckResult; fetched: string[] }> => {
    const fetched: string[] = [];
    const result = await checkAdministrativeNeed({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
      noPdf: false,
      analyzer: { provider: 'mock', model: null, analyze: async () => validAnalysis() },
      companyFitCriteria: fitCriteria(),
      limits: { htmlCharacters: 30_000, pdfCharacters: 50_000, maxPdfs },
    }, {
      extractContent: async () => makeDocument({ pdfLinks: [...pdfLinks] }),
      extractPdf: async (input) => {
        fetched.push(input.url);
        return extractPdf(input);
      },
    });
    return { result, fetched };
  };

  it('no_textはAI入力枠を消費せず、次候補をrefillする', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '概要（画像PDF）' },
        { url: PDF_B, text: '別記仕様書' },
        { url: PDF_C, text: '入札説明書' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw noTextError();
        return makePdf(url);
      },
    );

    // 取得順は優先度順（別記仕様書=high → 概要=medium → 入札説明書=other）。
    // 上限2件でも、no_text が枠を消費しないので3件目まで進む。
    expect(fetched).toEqual([PDF_B, PDF_A, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['別記仕様書', '入札説明書']);
  });

  it('pdf_failedのまま、detail=no_textでWARNINGにする', async () => {
    const { result } = await run(
      [
        { url: PDF_A, text: '概要（画像PDF）' },
        { url: PDF_B, text: '別記仕様書' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw noTextError();
        return makePdf(url);
      },
    );

    const failure = result.warnings.find((warning) => warning.detail === 'no_text');
    expect(failure).toBeDefined();
    expect(failure!.code).toBe('pdf_failed');
    expect(warningSeverity(failure!)).toBe('warning');
    expect(failure!.message).toContain('テキストレイヤーが無い');
    expect(failure!.message).toContain(PDF_A);
  });

  it('no_textのPDFはAI入力に含めずpdfSkippedへ入れる', async () => {
    const { result } = await run(
      [
        { url: PDF_A, text: '概要（画像PDF）' },
        { url: PDF_B, text: '別記仕様書' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw noTextError();
        return makePdf(url);
      },
    );
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.url)).not.toContain(PDF_A);
    expect(result.inputSummary.pdfSkipped?.map((pdf) => pdf.url)).toContain(PDF_A);
  });

  it.each([
    ['parse_failed', new PdfCheckError('parse_failed', 'PDFの解析に失敗しました。')],
    ['invalid_pdf', new PdfCheckError('invalid_pdf', 'PDFヘッダーを確認できません。')],
    ['parse_timeout', new PdfCheckError('parse_timeout', 'PDFの解析がタイムアウトしました。')],
    ['too_many_pages', new PdfCheckError('too_many_pages', 'ページ数が上限を超えています。')],
    ['HTTP取得失敗', new Error('HTTPステータスが成功範囲ではありません: 404')],
  ])('%s は従来どおり枠を消費する', async (_label, thrown) => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '別記仕様書' },
        { url: PDF_B, text: '公告文' },
        { url: PDF_C, text: '入札説明書' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw thrown;
        return makePdf(url);
      },
    );

    // PDF_A の失敗が1枠、PDF_B の採用で1枠。maxPdfs=2 に達し PDF_C は取得しない。
    expect(fetched).toEqual([PDF_A, PDF_B]);
    expect(result.inputSummary.pdfIncluded).toBe(1);
    expect(result.warnings.some((warning) => warning.detail === 'no_text')).toBe(false);
  });

  it('パスワード保護は従来どおり枠非消費でrefillする', async () => {
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '別記仕様書' },
        { url: PDF_B, text: '公告文' },
        { url: PDF_C, text: '入札説明書' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw passwordProtectedError();
        return makePdf(url);
      },
    );

    expect(fetched).toEqual([PDF_A, PDF_B, PDF_C]);
    expect(result.inputSummary.pdfIncluded).toBe(2);
    const failure = result.warnings.find((warning) => warning.detail === 'password_protected');
    expect(failure?.code).toBe('pdf_failed');
    expect(warningSeverity(failure!)).toBe('warning');
  });

  it('no_text・重複・パスワード保護が混在してもそれぞれ独立して扱う', async () => {
    const SHARED = '同一内容のPDF本文です。';
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '概要（画像PDF）' },
        { url: PDF_B, text: '別記仕様書（保護）' },
        { url: PDF_C, text: '本編' },
        { url: PDF_D, text: '印刷用' },
        { url: PDF_E, text: '実施状況' },
      ],
      async ({ url }) => {
        if (url === PDF_A) throw noTextError();
        if (url === PDF_B) throw passwordProtectedError();
        if (url === PDF_C || url === PDF_D) return makePdf(url, SHARED);
        return makePdf(url);
      },
      2,
    );

    // 取得順は優先度順（別記仕様書=high → 概要=medium → 残りは掲載順）。
    // no_text・保護・重複はいずれも枠を消費しないので、5件すべて取得を試す。
    expect(fetched).toEqual([PDF_B, PDF_A, PDF_C, PDF_D, PDF_E]);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual(['本編', '実施状況']);
    const details = result.warnings.map((warning) => warning.detail);
    expect(details).toContain('no_text');
    expect(details).toContain('password_protected');
    expect(result.warnings.some((warning) => warning.code === 'pdf_duplicate')).toBe(true);
  });

  it('福岡型の候補順で有効PDF3件がAI入力対象になる', async () => {
    const MAIN = '福岡市ＤＸ戦略の本文です。趣旨・目的と基本方針を記載しています。';
    // 実際の福岡と同じ並び。概要がmediumで先頭に来る。
    const { result, fetched } = await run(
      [
        { url: PDF_A, text: '福岡市DX戦略（本編）' },
        { url: PDF_B, text: '印刷用はこちら' },
        { url: PDF_C, text: '福岡市DX戦略 実行項目集' },
        { url: PDF_D, text: '福岡市DX戦略の概要' },
        { url: PDF_E, text: '福岡市ＤＸ戦略実行項目の実施状況（令和６年度）' },
      ],
      async ({ url }) => {
        if (url === PDF_D) throw noTextError();
        if (url === PDF_A || url === PDF_B) return makePdf(url, MAIN);
        return makePdf(url);
      },
      3,
    );

    // 概要(medium)が先頭。no_textで枠非消費、印刷用は重複で枠非消費。
    expect(fetched).toEqual([PDF_D, PDF_A, PDF_B, PDF_C, PDF_E]);
    expect(result.inputSummary.pdfIncluded).toBe(3);
    expect(result.inputSummary.pdfInputs.map((pdf) => pdf.label)).toEqual([
      '福岡市DX戦略（本編）',
      '福岡市DX戦略 実行項目集',
      '福岡市ＤＸ戦略実行項目の実施状況（令和６年度）',
    ]);
    expect(result.warnings.some((warning) => warning.detail === 'no_text')).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'pdf_duplicate')).toBe(true);
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

  it('Claudeへ渡した原文の合計と内訳を表示する', () => {
    const formatted = formatAiCheckResult(makeAiCheckResult({
      inputSummary: {
        htmlOriginalCharacters: 1_805,
        htmlSentCharacters: 1_805,
        pdfDiscovered: 4,
        pdfAttempted: 2,
        pdfIncluded: 2,
        pdfOriginalCharacters: 18_420,
        pdfSentCharacters: 18_420,
        totalSourceCharacters: 20_225,
        pdfInputs: [
          { label: '基本仕様書', url: PDF_A, characters: 12_400, extractedCharacters: 12_400, strategy: 'full' as const, chunkCount: 1 },
          { label: '公募実施要領', url: PDF_B, characters: 6_020, extractedCharacters: 6_020, strategy: 'full' as const, chunkCount: 1 },
        ],
        pdfSkipped: [
          { label: '評価基準', url: PDF_C },
          { label: '様式1 参加申込書', url: `${PDF_C}?v=2` },
        ],
      },
    }));
    expect(formatted).toContain('Total source characters: 20225');
    expect(formatted).toContain('- 基本仕様書: 12400 chars');
    expect(formatted).toContain('- 公募実施要領: 6020 chars');
    expect(formatted).toContain('PDF skipped from AI input:');
    expect(formatted).toContain('- 評価基準');
    expect(formatted).toContain('- 様式1 参加申込書');
  });

  it('切り詰めが起きたときだけ抽出全文の文字数を併記する', () => {
    const truncated = formatAiCheckResult(makeAiCheckResult({
      inputSummary: {
        ...makeAiCheckResult().inputSummary,
        pdfDiscovered: 1,
        pdfAttempted: 1,
        pdfIncluded: 1,
        pdfOriginalCharacters: 49_846,
        pdfSentCharacters: 20_000,
        totalSourceCharacters: 20_500,
        pdfInputs: [{ label: '募集要項', url: PDF_A, characters: 20_000, extractedCharacters: 49_846, strategy: 'relevant_chunks' as const, chunkCount: 5 }],
      },
    }));
    expect(truncated).toContain('PDF characters: 20000 (extracted 49846)');
    // 切り詰めが無い候補では併記しない。
    expect(formatAiCheckResult(makeAiCheckResult())).toContain('PDF characters: 0\n');
  });

  it('入力トークン数が取れたときだけ表示する', () => {
    expect(formatAiCheckResult(makeAiCheckResult({ inputTokens: 12_345 })))
      .toContain('Claude input tokens: 12345');
    expect(formatAiCheckResult(makeAiCheckResult())).not.toContain('Claude input tokens');
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

/** PDF.jsのPasswordExceptionをPdfCheckErrorで包んだ形を再現する。 */
function passwordProtectedError(): PdfCheckError {
  return new PdfCheckError(
    'password_protected',
    'PDFがパスワード保護されているため本文を取得できません。',
    { cause: Object.assign(new Error('No password given'), { name: 'PasswordException' }) },
  );
}

/**
 * 既定の本文はURLごとに変える。内容が同一だと重複除外が働き、優先度・refill・
 * 件数上限のテストが本来の意図とずれるため。重複を試すテストだけ text を明示する。
 */
function makePdf(url: string, text = `PDFから抽出した本文です。（${url}）`): ExtractedPdf {
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
      totalSourceCharacters: 500,
      pdfInputs: [],
      pdfSkipped: [],
    },
    evidenceMatched: 1,
    warnings: [],
    ...overrides,
  };
}
