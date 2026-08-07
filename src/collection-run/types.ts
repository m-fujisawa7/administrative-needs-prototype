import type { RegisterOneResult } from '../notion-register/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';

export type CollectionRunCliOptions = {
  sourceId: string;
  limit: number;
  databaseId: string;
  write: boolean;
  since?: string;
};

export type CollectionRunItemResult = {
  candidate: SourceCheckSample;
  result: RegisterOneResult;
};

export type CollectionRunReport = {
  write: boolean;
  sourceId: string;
  effectiveSince: string;
  runStartedAt: string;
  candidatesCollected: number;
  uniqueCandidates: number;
  candidatesInPeriod: number;
  newCandidatesFound: number;
  processedNewCandidates: number;
  remainingNewCandidates: number;
  results: CollectionRunItemResult[];
  collectionState: CollectionStateOutcome;
};

export type CollectionStateOutcome =
  | {
    status: 'advanced';
    newLastSuccessfulCheck: string;
  }
  | {
    status: 'not_advanced';
    reason: string;
  };
