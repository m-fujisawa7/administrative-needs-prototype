import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import type {
  ExistingNotionPage,
  RegisterOneResult,
} from '../notion-register/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import type {
  CollectionRunItemResult,
  CollectionRunReport,
  CollectionStateOutcome,
} from './types.ts';

export type CollectionCandidateProcessor = (
  candidate: SourceCheckSample,
) => Promise<RegisterOneResult>;

export type CollectionResultHandler = (
  item: CollectionRunItemResult,
  index: number,
  total: number,
) => void;

export function selectUniqueCandidates(
  candidates: SourceCheckSample[],
): SourceCheckSample[] {
  const seen = new Set<string>();
  const unique: SourceCheckSample[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  return unique;
}

export type CandidatePeriodSelection = {
  candidates: SourceCheckSample[];
  unknownDateCandidates: SourceCheckSample[];
};

export function filterCandidatesByPeriod(
  candidates: SourceCheckSample[],
  effectiveSince: string,
  runStartedAt: string,
): CandidatePeriodSelection {
  const selected: SourceCheckSample[] = [];
  const unknownDateCandidates: SourceCheckSample[] = [];
  for (const candidate of candidates) {
    if (candidate.publishedAt === null || !isRecognizedDate(candidate.publishedAt)) {
      selected.push(candidate);
      unknownDateCandidates.push(candidate);
      continue;
    }
    if (isInPeriod(candidate.publishedAt, effectiveSince, runStartedAt)) {
      selected.push(candidate);
    }
  }
  return { candidates: selected, unknownDateCandidates };
}

export type ProcessCollectedCandidatesInput = {
  sourceId: string;
  candidates: SourceCheckSample[];
  candidatesCollected: number;
  uniqueCandidates: number;
  effectiveSince: string;
  runStartedAt: string;
  limit: number;
  write: boolean;
  checkDuplicate: (officialUrl: string) => Promise<ExistingNotionPage | null>;
  processor: CollectionCandidateProcessor;
  collectionState?: CollectionStateOutcome;
  onResult?: CollectionResultHandler;
};

export async function processCollectedCandidates(
  input: ProcessCollectedCandidatesInput,
): Promise<CollectionRunReport> {
  const results: CollectionRunItemResult[] = [];
  let newCandidatesFound = 0;
  let processedNewCandidates = 0;
  let remainingNewCandidates = 0;
  const onResult = input.onResult ?? (() => undefined);

  for (const [index, candidate] of input.candidates.entries()) {
    let duplicate: ExistingNotionPage | null;
    try {
      duplicate = await input.checkDuplicate(candidate.url);
    } catch (error) {
      const result: RegisterOneResult = {
        status: 'failed',
        officialUrl: candidate.url,
        stage: 'duplicate_check',
        message: safeNotionRegistrationErrorMessage(error),
        configurationError: false,
        warnings: [],
      };
      const item = { candidate, result };
      results.push(item);
      onResult(item, index + 1, input.candidates.length);
      continue;
    }
    if (duplicate !== null) {
      const result: RegisterOneResult = {
        status: 'duplicate',
        officialUrl: candidate.url,
        existingPageId: duplicate.id,
        existingPageUrl: duplicate.url,
        phase: 'preflight',
        warnings: [],
      };
      const item = { candidate, result };
      results.push(item);
      onResult(item, index + 1, input.candidates.length);
      continue;
    }

    newCandidatesFound += 1;
    if (processedNewCandidates >= input.limit) {
      remainingNewCandidates += 1;
      continue;
    }
    processedNewCandidates += 1;
    let result: RegisterOneResult;
    try {
      result = await input.processor(candidate);
    } catch (error) {
      result = {
        status: 'failed',
        officialUrl: candidate.url,
        stage: 'ai_analysis',
        message: safeNotionRegistrationErrorMessage(error),
        configurationError: false,
        warnings: [],
      };
    }
    const item = { candidate, result };
    results.push(item);
    onResult(item, index + 1, input.candidates.length);
  }

  return {
    write: input.write,
    sourceId: input.sourceId,
    effectiveSince: input.effectiveSince,
    runStartedAt: input.runStartedAt,
    candidatesCollected: input.candidatesCollected,
    uniqueCandidates: input.uniqueCandidates,
    candidatesInPeriod: input.candidates.length,
    newCandidatesFound,
    processedNewCandidates,
    remainingNewCandidates,
    results,
    collectionState: input.collectionState ?? {
      status: 'not_advanced',
      reason: 'Collection state has not been evaluated.',
    },
  };
}

function isRecognizedDate(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00+09:00`);
    const shifted = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
    return Number.isFinite(parsed.getTime()) && shifted.toISOString().slice(0, 10) === value;
  }
  return Number.isFinite(Date.parse(value));
}

function isInPeriod(value: string, effectiveSince: string, runStartedAt: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = value;
    return date >= effectiveSince.slice(0, 10) && date <= runStartedAt.slice(0, 10);
  }
  const publishedAt = Date.parse(value);
  return publishedAt >= Date.parse(normalizePeriodBoundary(effectiveSince))
    && publishedAt <= Date.parse(runStartedAt);
}

function normalizePeriodBoundary(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value;
}
