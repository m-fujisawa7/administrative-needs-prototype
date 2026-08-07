import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AiAnalyzerError } from '../src/ai/errors.ts';
import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../src/ai/types.ts';
import {
  parseSourceVerifyArgs,
  runSourceVerify,
  type SourceVerifyCommandDependencies,
} from '../src/commands/source-verify.ts';
import type { ExtractedDocument } from '../src/content-check/types.ts';
import type { ExtractedPdf } from '../src/pdf-check/types.ts';
import type { SourceCheckSample } from '../src/source-check/types.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

const URL_A = 'https://example-city.test/cases/a.html';
const URL_B = 'https://example-city.test/cases/b.html';
const URL_C = 'https://example-city.test/cases/c.html';
const PDF_URL = 'https://example-city.test/files/a.pdf';

describe('source:verify引数', () => {
  it('--sourceを必須とし、limitの初期値を3にする', () => {
    expect(parseSourceVerifyArgs(['--source', 'example-source'])).toEqual({
      sourceId: 'example-source',
      limit: 3,
    });
    expect(() => parseSourceVerifyArgs([])).toThrow('--source');
  });

  it.each(['1', '5'])('--limit %sを受理する', (limit) => {
    expect(parseSourceVerifyArgs([
      '--source=example-source',
      `--limit=${limit}`,
    ]).limit).toBe(Number(limit));
  });

  it.each(['0', '6', 'abc'])('--limit %sを拒否する', (limit) => {
    expect(() => parseSourceVerifyArgs([
      '--source', 'example-source',
      '--limit', limit,
    ])).toThrow('--limit');
  });
});

describe('source:verifyコマンド', () => {
  it('Source不存在をエラーにしてCollectorへ進まない', async () => {
    const collectCandidates = vi.fn();
    const stderr: string[] = [];
    const exitCode = await runSourceVerify(
      ['--source', 'missing-source'],
      dependencies({ collectCandidates, stderr }),
    );
    expect(exitCode).toBe(1);
    expect(collectCandidates).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('Source not found: missing-source');
  });

  it('候補0件はContentとAIを呼ばず正常終了する', async () => {
    const analyzerFactory = vi.fn();
    const extractContent = vi.fn();
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(args(), dependencies({
      stdout,
      collectCandidates: async () => [],
      analyzerFactory,
      extractContent,
    }));
    expect(exitCode).toBe(0);
    expect(analyzerFactory).not.toHaveBeenCalled();
    expect(extractContent).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('Candidates found: 0');
    expect(stdout.join('\n')).toContain('Ready for collection:\nCHECK REQUIRED');
  });

  it('候補3件を直列に本文取得・AI解析し、PDF本文もAnalyzerへ渡す', async () => {
    const active: string[] = [];
    let maximumActive = 0;
    const analyze = vi.fn(async (input: AdministrativeNeedAnalysisInput) => {
      active.push(input.officialUrl);
      maximumActive = Math.max(maximumActive, active.length);
      await Promise.resolve();
      active.pop();
      return targetAnalysis(input);
    });
    const extractContent = vi.fn(async (input) => document(
      input.url,
      input.url === URL_A ? [PDF_URL] : [],
    ));
    const extractPdf = vi.fn(async () => pdf());
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(args(), dependencies({
      stdout,
      analyzerFactory: () => analyzer(analyze),
      extractContent,
      extractPdf,
    }));

    expect(exitCode).toBe(0);
    expect(extractContent).toHaveBeenCalledTimes(3);
    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(1);
    expect(analyze.mock.calls[0]?.[0].pdfDocuments).toEqual([{
      url: PDF_URL,
      text: 'PDF fixture text',
    }]);
    expect(analyze.mock.calls[1]?.[0].pdfDocuments).toEqual([]);
    expect(stdout.join('\n')).toContain('Ready for collection:\nYES');
    expect(stdout.join('\n')).toContain('Notion write:\nSkipped');
    expect(stdout.join('\n')).toContain('Collection state:\nUnchanged');
  });

  it('--limit 2では先頭2件だけを確認する', async () => {
    const extractContent = vi.fn(async (input) => document(input.url));
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(
      [...args(), '--limit', '2'],
      dependencies({ stdout, extractContent }),
    );
    expect(exitCode).toBe(0);
    expect(extractContent).toHaveBeenCalledTimes(2);
    expect(extractContent.mock.calls.map(([input]) => input.url)).toEqual([URL_A, URL_B]);
    expect(stdout.join('\n')).toContain(`3. Candidate ${URL_C.at(-6)}\n   ${URL_C}`);
    expect(stdout.join('\n')).toContain('Samples selected: 2');
  });

  it('1件の本文取得失敗後も残りを処理して最終サマリを出す', async () => {
    const extractContent = vi.fn(async (input) => {
      if (input.url === URL_A) throw new Error('fixture content failure');
      return document(input.url);
    });
    const analyze = vi.fn(async (input: AdministrativeNeedAnalysisInput) => targetAnalysis(input));
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(args(), dependencies({
      stdout,
      extractContent,
      analyzerFactory: () => analyzer(analyze),
    }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(1);
    expect(extractContent).toHaveBeenCalledTimes(3);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(output).toContain('[1/3] Verification failed');
    expect(output).toContain('[3/3] Verification completed');
    expect(output).toContain('Content failed:\n1');
    expect(output).toContain('AI analysis succeeded:\n2');
    expect(output).toContain('Ready for collection:\nCHECK REQUIRED');
  });

  it('1件のAI失敗後も残りを処理し、本文成功として集計する', async () => {
    const analyze = vi.fn(async (input: AdministrativeNeedAnalysisInput) => {
      if (input.officialUrl === URL_A) throw new AiAnalyzerError('fixture AI failure');
      return targetAnalysis(input);
    });
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(args(), dependencies({
      stdout,
      analyzerFactory: () => analyzer(analyze),
    }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(output).toContain('Content succeeded:\n3');
    expect(output).toContain('Content failed:\n0');
    expect(output).toContain('AI analysis succeeded:\n2');
    expect(output).toContain('AI analysis failed:\n1');
  });

  it('is_target=falseも解析成功としてReady YESにする', async () => {
    const stdout: string[] = [];
    const exitCode = await runSourceVerify(args(), dependencies({
      stdout,
      collectCandidates: async () => [candidate(URL_A)],
      analyzerFactory: () => analyzer(async (input) => targetAnalysis(input, false)),
    }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(0);
    expect(output).toContain('Target:\nfalse');
    expect(output).toContain('AI analysis succeeded:\n1');
    expect(output).toContain('Ready for collection:\nYES');
  });

  it('ClaudeのJSON parse再試行成功をWarningとして表示する', async () => {
    const stderr: string[] = [];
    const retryingAnalyzer: AdministrativeNeedAnalyzer = {
      provider: 'claude_cli',
      model: null,
      analyze: async (input) => targetAnalysis(input),
      getLastRunInfo: () => ({ jsonParseRetryCount: 1 }),
    };
    const exitCode = await runSourceVerify(args(), dependencies({
      stderr,
      collectCandidates: async () => [candidate(URL_A)],
      analyzerFactory: () => retryingAnalyzer,
    }));

    expect(exitCode).toBe(0);
    expect(stderr.join('\n')).toContain('[WARNING] [ai_json_parse_retry]');
    expect(stderr.join('\n')).toContain('1回再試行して成功しました');
  });

  it('Collector失敗はAIへ進まず終了コード1にする', async () => {
    const analyzerFactory = vi.fn();
    const exitCode = await runSourceVerify(args(), dependencies({
      collectCandidates: async () => {
        throw new Error('fixture collector failure');
      },
      analyzerFactory,
    }));
    expect(exitCode).toBe(1);
    expect(analyzerFactory).not.toHaveBeenCalled();
  });

  it('Notion APIを呼ばずcollection stateも変更しない', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'source-verify-boundary-'));
    const statePath = join(temporaryDirectory, 'data', 'collection-state.json');
    const originalWorkingDirectory = process.cwd();
    const externalFetch = vi.fn();
    await mkdir(join(temporaryDirectory, 'data'));
    await writeFile(statePath, '{"sentinel":"unchanged"}\n', 'utf8');
    vi.stubGlobal('fetch', externalFetch);
    try {
      process.chdir(temporaryDirectory);
      const exitCode = await runSourceVerify(args(), dependencies({}));
      expect(exitCode).toBe(0);
      expect(externalFetch).not.toHaveBeenCalled();
      await expect(readFile(statePath, 'utf8')).resolves.toBe(
        '{"sentinel":"unchanged"}\n',
      );
    } finally {
      process.chdir(originalWorkingDirectory);
      vi.unstubAllGlobals();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

function args(): string[] {
  return ['--source', 'example-source'];
}

function dependencies(options: {
  stdout?: string[];
  stderr?: string[];
  collectCandidates?: NonNullable<SourceVerifyCommandDependencies['collectCandidates']>;
  analyzerFactory?: NonNullable<SourceVerifyCommandDependencies['analyzerFactory']>;
  extractContent?: NonNullable<SourceVerifyCommandDependencies['extractContent']>;
  extractPdf?: NonNullable<SourceVerifyCommandDependencies['extractPdf']>;
}): SourceVerifyCommandDependencies {
  return {
    env: { AI_PROVIDER: 'mock' },
    loadRegistry: async () => registry(),
    collectCandidates: options.collectCandidates ?? (async () => [
      candidate(URL_A),
      candidate(URL_B),
      candidate(URL_C),
    ]),
    loadFitCriteria: async () => fitCriteria(),
    loadPrompt: async () => 'fixture prompt',
    analyzerFactory: options.analyzerFactory ?? (() => analyzer(
      async (input) => targetAnalysis(input),
    )),
    extractContent: options.extractContent ?? (async (input) => document(input.url)),
    extractPdf: options.extractPdf ?? (async () => pdf()),
    stdout: (message) => options.stdout?.push(message),
    stderr: (message) => options.stderr?.push(message),
  };
}

function registry() {
  return validateSourceRegistry({
    version: 1,
    organizations: [{
      id: 'example-city',
      name: '例市',
      organization_type: 'municipality',
      official_domain: 'example-city.test',
      enabled: true,
    }],
    sources: [{
      id: 'example-source',
      organization_id: 'example-city',
      name: '例市の課題一覧',
      url: 'https://example-city.test/cases/',
      collector_type: 'list_page',
      source_category: 'proposal',
      priority: 'high',
      enabled: true,
      link_selector: 'a.case',
    }],
  });
}

function candidate(url: string): SourceCheckSample {
  return { title: `Candidate ${url.at(-6)}`, url, publishedAt: '2026-08-07' };
}

function document(url: string, pdfUrls: string[] = []): ExtractedDocument {
  const bodyText = `HTML fixture body for ${url}`;
  return {
    sourceId: 'example-source',
    sourceEnabled: true,
    requestedUrl: url,
    url,
    httpStatus: 200,
    contentType: 'text/html',
    responseBytes: 1_000,
    durationMs: 1,
    redirectCount: 0,
    title: `Document ${url.at(-6)}`,
    bodyText,
    bodyLength: bodyText.length,
    publishedAtCandidate: '2026-08-07',
    publishedAtSource: 'page_text',
    pdfUrls,
    contentSelectorConfigured: null,
    contentSelectorUsed: 'main',
    usedFallback: true,
    warnings: [],
  };
}

function pdf(): ExtractedPdf {
  return {
    sourceId: 'example-source',
    sourceEnabled: true,
    requestedUrl: PDF_URL,
    url: PDF_URL,
    httpStatus: 200,
    contentType: 'application/pdf',
    responseBytes: 2_000,
    durationMs: 1,
    redirectCount: 0,
    parser: 'unpdf',
    pageCount: 1,
    pageTexts: ['PDF fixture text'],
    text: 'PDF fixture text',
    characterCount: 16,
    pagesWithText: 1,
    emptyPageCount: 0,
    warnings: [],
  };
}

function analyzer(
  analyze: AdministrativeNeedAnalyzer['analyze'],
): AdministrativeNeedAnalyzer {
  return { provider: 'mock', model: null, analyze };
}

function targetAnalysis(
  input: AdministrativeNeedAnalysisInput,
  isTarget = true,
): AdministrativeNeedAnalysis {
  if (!isTarget) {
    return {
      is_target: false,
      document_type: 'other',
      problem_summary: '',
      desired_state: '',
      request_to_private_sector: '',
      categories: [],
      company_relevance: 'out_of_scope',
      contact_recommendation: 'none',
      reason: '対象外のfixtureです。',
      evidence_quotes: [{
        source_type: 'html',
        source_url: input.officialUrl,
        quote: input.htmlText.slice(0, 20),
      }],
    };
  }
  return {
    is_target: true,
    document_type: 'proposal',
    problem_summary: '行政課題のfixtureです。',
    desired_state: '課題が解決した状態です。',
    request_to_private_sector: '解決策の提案を求めます。',
    categories: ['行政DX'],
    company_relevance: 'B',
    contact_recommendation: 'medium',
    reason: '提案募集のfixtureです。',
    evidence_quotes: [{
      source_type: 'html',
      source_url: input.officialUrl,
      quote: input.htmlText.slice(0, 20),
    }],
  };
}

function fitCriteria(): CompanyFitCriteria {
  return {
    version: 1,
    name: 'fixture',
    directFit: ['行政DX'],
    partnerFit: ['共同提案'],
    strategicInterest: ['調査段階'],
    outOfScope: ['物品のみ'],
  };
}
