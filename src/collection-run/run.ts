import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import type { RegisterOneResult } from '../notion-register/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import type {
  CollectionRunItemResult,
  CollectionRunReport,
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
  limit: number,
): SourceCheckSample[] {
  const seen = new Set<string>();
  const unique: SourceCheckSample[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  return unique.slice(0, limit);
}

export async function processCollectedCandidates(
  sourceId: string,
  candidates: SourceCheckSample[],
  limit: number,
  write: boolean,
  processor: CollectionCandidateProcessor,
  onResult: CollectionResultHandler = () => undefined,
): Promise<CollectionRunReport> {
  const selected = selectUniqueCandidates(candidates, limit);
  const results: CollectionRunItemResult[] = [];

  for (const [index, candidate] of selected.entries()) {
    let result: RegisterOneResult;
    try {
      result = await processor(candidate);
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
    onResult(item, index + 1, selected.length);
  }

  return {
    write,
    sourceId,
    candidatesCollected: candidates.length,
    uniqueCandidates: selected.length,
    results,
  };
}
