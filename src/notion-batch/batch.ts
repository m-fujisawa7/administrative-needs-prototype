import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import type { RegisterOneResult } from '../notion-register/types.ts';
import type {
  NotionBatchItemResult,
  NotionBatchReport,
  ParsedSelectedUrls,
} from './types.ts';

export type NotionBatchProcessor = (officialUrl: string) => Promise<RegisterOneResult>;
export type NotionBatchResultHandler = (
  result: NotionBatchItemResult,
  index: number,
  total: number,
) => void;

export async function processSelectedUrls(
  input: ParsedSelectedUrls,
  write: boolean,
  processor: NotionBatchProcessor,
  onResult: NotionBatchResultHandler = () => undefined,
): Promise<NotionBatchReport> {
  const results: NotionBatchItemResult[] = [];
  for (const [index, entry] of input.entries.entries()) {
    let result: NotionBatchItemResult;
    if (entry.inputDuplicate) {
      result = {
        status: 'input_duplicate',
        officialUrl: entry.officialUrl,
        warnings: [],
      };
    } else {
      try {
        result = await processor(entry.officialUrl);
      } catch (error) {
        result = {
          status: 'failed',
          officialUrl: entry.officialUrl,
          stage: 'ai_analysis',
          message: safeNotionRegistrationErrorMessage(error),
          configurationError: false,
          warnings: [],
        };
      }
    }
    results.push(result);
    onResult(result, index + 1, input.entries.length);
  }
  return {
    write,
    inputLines: input.entries.length,
    validUniqueUrls: input.uniqueUrlCount,
    results,
  };
}
