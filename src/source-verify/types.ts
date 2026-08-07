import type { AiCheckResult } from '../ai/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';

export type SourceVerifyCliOptions = {
  sourceId: string;
  limit: number;
};

export type ContentVerificationSnapshot = {
  htmlCharacters: number;
  pdfDiscovered: number;
  pdfExtracted: number;
  pdfCharacters: number;
};

export type SourceVerifyItemResult =
  | {
    status: 'succeeded';
    candidate: SourceCheckSample;
    result: AiCheckResult;
  }
  | {
    status: 'failed';
    candidate: SourceCheckSample;
    stage: 'content' | 'ai';
    message: string;
    content?: ContentVerificationSnapshot;
  };

export type SourceVerifyReport = {
  sourceId: string;
  candidatesFound: number;
  samplesSelected: number;
  results: SourceVerifyItemResult[];
};
