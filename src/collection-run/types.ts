import type { RegisterOneResult } from '../notion-register/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';

export type CollectionRunCliOptions = {
  sourceId: string;
  limit: number;
  databaseId: string;
  write: boolean;
};

export type CollectionRunItemResult = {
  candidate: SourceCheckSample;
  result: RegisterOneResult;
};

export type CollectionRunReport = {
  write: boolean;
  sourceId: string;
  candidatesCollected: number;
  uniqueCandidates: number;
  results: CollectionRunItemResult[];
};
