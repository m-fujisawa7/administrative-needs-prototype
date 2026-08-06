import { pathToFileURL } from 'node:url';
import { checkAdministrativeNeed } from '../ai/check.ts';
import { loadCompanyFitCriteria } from '../ai/company-fit-criteria.ts';
import { createAnalyzer } from '../ai/create-analyzer.ts';
import { AiConfigurationError } from '../ai/errors.ts';
import { aiInputLimitsFromEnvironment } from '../ai/input.ts';
import { loadAiCheckPrompt } from '../ai/prompt.ts';
import type {
  AdministrativeNeedAnalyzer,
  AiCheckCliOptions,
  AiCheckResult,
  CompanyFitCriteria,
} from '../ai/types.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import type { SourceRegistry } from '../source-registry/schema.ts';

const DOCUMENT_TYPE_LABELS: Record<AiCheckResult['analysis']['document_type'], string> = {
  rfi: 'RFI・情報提供依頼',
  sounding: 'サウンディング',
  private_proposal: '民間提案',
  proposal: 'プロポーザル',
  bid: '入札',
  pilot: '実証事業',
  public_private_partnership: '官民連携',
  plan: '計画・方針',
  council: '議会',
  budget: '予算',
  committee: '審議会・検討会',
  administrative_evaluation: '行政評価',
  other: 'その他',
};

const CONTACT_LABELS: Record<AiCheckResult['analysis']['contact_recommendation'], string> = {
  high: '高',
  medium: '中',
  low: '低',
  none: '不要',
};

export type AiCheckCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  loadRegistry?: () => Promise<SourceRegistry>;
  loadFitCriteria?: () => Promise<CompanyFitCriteria>;
  loadPrompt?: () => Promise<string>;
  analyzerFactory?: (systemPrompt: string) => AdministrativeNeedAnalyzer;
  checkNeed?: typeof checkAdministrativeNeed;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseAiCheckArgs(argv: string[]): AiCheckCliOptions {
  let sourceId: string | undefined;
  let url: string | undefined;
  let json = false;
  let noPdf = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') {
      sourceId = setOnce(sourceId, requireValue(argv, index, argument), '--source');
      index += 1;
      continue;
    }
    if (argument?.startsWith('--source=')) {
      sourceId = setOnce(sourceId, requireInlineValue(argument, '--source='), '--source');
      continue;
    }
    if (argument === '--url') {
      url = setOnce(url, requireValue(argv, index, argument), '--url');
      index += 1;
      continue;
    }
    if (argument?.startsWith('--url=')) {
      url = setOnce(url, requireInlineValue(argument, '--url='), '--url');
      continue;
    }
    if (argument === '--json') {
      if (json) throw new Error('--json は1回だけ指定してください。');
      json = true;
      continue;
    }
    if (argument === '--no-pdf') {
      if (noPdf) throw new Error('--no-pdf は1回だけ指定してください。');
      noPdf = true;
      continue;
    }
    throw new Error(`不明なオプションです: ${argument}`);
  }

  if (sourceId === undefined) throw new Error('--source を指定してください。');
  if (url === undefined) throw new Error('--url を指定してください。');
  validateHttpUrl(url);
  return { sourceId, url, json, noPdf };
}

export async function runAiCheck(
  argv = process.argv.slice(2),
  dependencies: AiCheckCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const env = dependencies.env ?? process.env;

  let options: AiCheckCliOptions;
  let registry: SourceRegistry;
  let companyFitCriteria: CompanyFitCriteria;
  let analyzer: AdministrativeNeedAnalyzer;
  try {
    options = parseAiCheckArgs(argv);
    registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
    companyFitCriteria = await (
      dependencies.loadFitCriteria ?? loadCompanyFitCriteria
    )();
    const systemPrompt = await (dependencies.loadPrompt ?? loadAiCheckPrompt)();
    analyzer = dependencies.analyzerFactory?.(systemPrompt)
      ?? createAnalyzer({ systemPrompt, env });
  } catch (error) {
    stderr(formatAiCheckError(error));
    return 2;
  }

  const source = registry.sources.find((candidate) => candidate.id === options.sourceId);
  if (source === undefined) {
    stderr(`Source not found: ${options.sourceId}`);
    return 2;
  }
  const organization = registry.organizations.find(
    (candidate) => candidate.id === source.organization_id,
  );
  if (organization === undefined) {
    stderr(`Organization not found: ${source.organization_id}`);
    return 2;
  }

  try {
    const result = await (dependencies.checkNeed ?? checkAdministrativeNeed)({
      source,
      organization,
      url: options.url,
      noPdf: options.noPdf,
      analyzer,
      companyFitCriteria,
      limits: aiInputLimitsFromEnvironment(env),
    });
    for (const warning of result.warnings) {
      stderr(`[WARNING] [${warning.code}] ${warning.message}`);
    }
    stdout(options.json
      ? JSON.stringify(result.analysis, null, 2)
      : formatAiCheckResult(result));
    return 0;
  } catch (error) {
    stderr(formatAiCheckError(error));
    return error instanceof AiConfigurationError ? 2 : 1;
  }
}

export function formatAiCheckResult(result: AiCheckResult): string {
  const analysis = result.analysis;
  const lines = [
    'AI check completed.',
    `Source: ${result.organizationName} / ${result.sourceName}`,
    `Provider: ${result.provider}`,
    `Model: ${result.model ?? 'not applicable'}`,
    `Title: ${result.title}`,
    `Official URL: ${result.officialUrl}`,
    `Target: ${analysis.is_target ? 'Yes' : 'No'}`,
    `Document type: ${DOCUMENT_TYPE_LABELS[analysis.document_type]} (${analysis.document_type})`,
    `Problem: ${analysis.problem_summary || 'not found'}`,
    `Desired state: ${analysis.desired_state || 'not found'}`,
    `Request to private sector: ${analysis.request_to_private_sector || 'not found'}`,
    'Categories:',
    ...analysis.categories.map((category) => `  - ${category}`),
    `Company relevance: ${analysis.company_relevance}`,
    `Contact recommendation: ${CONTACT_LABELS[analysis.contact_recommendation]}`,
    `Reason: ${analysis.reason}`,
    'Evidence:',
  ];
  for (const evidence of analysis.evidence_quotes) {
    lines.push(`  - [${evidence.source_type}] ${evidence.quote}`);
    lines.push(`    ${evidence.source_url}`);
  }
  lines.push(
    `Evidence matched: ${result.evidenceMatched}/${analysis.evidence_quotes.length}`,
    'Input summary:',
    `  HTML characters: ${result.inputSummary.htmlSentCharacters}/${result.inputSummary.htmlOriginalCharacters}`,
    `  PDF documents: ${result.inputSummary.pdfIncluded}/${result.inputSummary.pdfDiscovered} (attempted ${result.inputSummary.pdfAttempted})`,
    `  PDF characters: ${result.inputSummary.pdfSentCharacters}/${result.inputSummary.pdfOriginalCharacters}`,
    `Warnings: ${result.warnings.length}`,
  );
  return lines.join('\n');
}

function formatAiCheckError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[ERROR] AI check failed. ${detail}`;
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) throw new Error(`${option} は1回だけ指定してください。`);
  return value;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} の値を指定してください。`);
  }
  return value;
}

function requireInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length);
  if (value === '') throw new Error(`${prefix.slice(0, -1)} の値を指定してください。`);
  return value;
}

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--url は正しいURLで指定してください。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--url は http または https で指定してください。');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAiCheck().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
