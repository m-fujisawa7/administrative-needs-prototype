import { pathToFileURL } from 'node:url';
import { checkAdministrativeNeed } from '../ai/check.ts';
import { loadCompanyFitCriteria } from '../ai/company-fit-criteria.ts';
import { createAnalyzer } from '../ai/create-analyzer.ts';
import {
  aiInputLimitsFromEnvironment,
  type AiInputLimits,
} from '../ai/input.ts';
import { loadAiCheckPrompt } from '../ai/prompt.ts';
import type {
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../ai/types.ts';
import type { ContentExtractor, PdfExtractor } from '../ai/check.ts';
import {
  formatSourceVerificationCandidates,
  formatSourceVerificationItem,
  formatSourceVerificationStarted,
  formatSourceVerificationSummary,
} from '../source-verify/format.ts';
import type { SourceVerifyCliOptions, SourceVerifyReport } from '../source-verify/types.ts';
import { verifySourceCandidates } from '../source-verify/verify.ts';
import { collectSourceCandidates } from '../source-check/index.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../source-registry/schema.ts';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

export type SourceVerifyCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  loadRegistry?: () => Promise<SourceRegistry>;
  collectCandidates?: (
    source: Source,
    organization: Organization,
  ) => Promise<SourceCheckSample[]>;
  loadFitCriteria?: () => Promise<CompanyFitCriteria>;
  loadPrompt?: () => Promise<string>;
  analyzerFactory?: (systemPrompt: string) => AdministrativeNeedAnalyzer;
  checkNeed?: typeof checkAdministrativeNeed;
  extractContent?: ContentExtractor;
  extractPdf?: PdfExtractor;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseSourceVerifyArgs(argv: string[]): SourceVerifyCliOptions {
  let sourceId: string | undefined;
  let limit = DEFAULT_LIMIT;
  let limitSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source' || argument?.startsWith('--source=')) {
      if (sourceId !== undefined) throw new Error('--source may only be specified once.');
      const parsed = readOptionValue(argv, index, argument, '--source');
      sourceId = parsed.value;
      index += parsed.consumedNext ? 1 : 0;
      continue;
    }
    if (argument === '--limit' || argument?.startsWith('--limit=')) {
      if (limitSpecified) throw new Error('--limit may only be specified once.');
      const parsed = readOptionValue(argv, index, argument, '--limit');
      limit = parseLimit(parsed.value);
      limitSpecified = true;
      index += parsed.consumedNext ? 1 : 0;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (sourceId === undefined) throw new Error('--source is required.');
  return { sourceId, limit };
}

export async function runSourceVerify(
  argv = process.argv.slice(2),
  dependencies: SourceVerifyCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const env = dependencies.env ?? process.env;

  let options: SourceVerifyCliOptions;
  let source: Source;
  let organization: Organization;
  try {
    options = parseSourceVerifyArgs(argv);
    const registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
    source = requireSource(registry, options.sourceId);
    organization = requireOrganization(registry, source.organization_id);
  } catch (error) {
    stderr(formatSourceVerifyError(error));
    return 1;
  }

  stdout(formatSourceVerificationStarted(source, organization, options));

  let candidates: SourceCheckSample[];
  try {
    candidates = await (
      dependencies.collectCandidates
      ?? ((selectedSource, selectedOrganization) =>
        collectSourceCandidates(selectedSource, selectedOrganization))
    )(source, organization);
  } catch (error) {
    stderr(formatSourceVerifyError(error, 'Candidate collection failed.'));
    return 1;
  }

  const selected = candidates.slice(0, options.limit);
  stdout(formatSourceVerificationCandidates(candidates, selected.length));
  if (selected.length === 0) {
    stdout(formatSourceVerificationSummary(emptyReport(source.id)));
    return 0;
  }

  let companyFitCriteria: CompanyFitCriteria;
  let analyzer: AdministrativeNeedAnalyzer;
  let limits: AiInputLimits;
  try {
    const [criteria, systemPrompt] = await Promise.all([
      (dependencies.loadFitCriteria ?? loadCompanyFitCriteria)(),
      (dependencies.loadPrompt ?? loadAiCheckPrompt)(),
    ]);
    companyFitCriteria = criteria;
    analyzer = dependencies.analyzerFactory?.(systemPrompt)
      ?? createAnalyzer({ systemPrompt, env });
    limits = aiInputLimitsFromEnvironment(env);
  } catch (error) {
    stderr(formatSourceVerifyError(error, 'AI setup failed.'));
    return 1;
  }

  const report = await verifySourceCandidates({
    source,
    organization,
    candidatesFound: candidates.length,
    candidates: selected,
    analyzer,
    companyFitCriteria,
    limits,
  }, {
    checkNeed: dependencies.checkNeed,
    extractContent: dependencies.extractContent,
    extractPdf: dependencies.extractPdf,
  }, (item, index, total) => {
    if (item.status === 'succeeded') {
      for (const warning of item.result.warnings) {
        stderr(`[${index}/${total}] [WARNING] [${warning.code}] ${warning.message}`);
      }
    }
    stdout(formatSourceVerificationItem(item, index, total));
  });
  stdout(formatSourceVerificationSummary(report));
  return report.results.some((item) => item.status === 'failed') ? 1 : 0;
}

function emptyReport(sourceId: string): SourceVerifyReport {
  return {
    sourceId,
    candidatesFound: 0,
    samplesSelected: 0,
    results: [],
  };
}

function requireSource(registry: SourceRegistry, sourceId: string): Source {
  const source = registry.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) throw new Error(`Source not found: ${sourceId}`);
  return source;
}

function requireOrganization(registry: SourceRegistry, organizationId: string): Organization {
  const organization = registry.organizations.find(
    (candidate) => candidate.id === organizationId,
  );
  if (organization === undefined) {
    throw new Error(`Organization not found: ${organizationId}`);
  }
  return organization;
}

function readOptionValue(
  argv: string[],
  index: number,
  argument: string,
  option: '--source' | '--limit',
): { value: string; consumedNext: boolean } {
  const inlinePrefix = `${option}=`;
  if (argument.startsWith(inlinePrefix)) {
    const value = argument.slice(inlinePrefix.length);
    if (value === '') throw new Error(`${option} requires a value.`);
    return { value, consumedNext: false };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return { value, consumedNext: true };
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return parsed;
}

function formatSourceVerifyError(error: unknown, prefix?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[ERROR] ${prefix === undefined ? detail : `${prefix} ${detail}`}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSourceVerify().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
