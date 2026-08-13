import { ClaudeUsageLimitError } from '../ai/errors.ts';
import type { ClaudeUsageLimitStop } from '../collection-run/types.ts';
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
  let usageLimit: ClaudeUsageLimitStop | undefined;
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
        if (error instanceof ClaudeUsageLimitError) {
          usageLimit = { message: error.limitMessage };
        }
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
    // 利用上限はClaude全体の状態なので、残りのURLを試さず打ち切る。
    if (usageLimit !== undefined) break;
  }
  return {
    write,
    inputLines: input.entries.length,
    validUniqueUrls: input.uniqueUrlCount,
    results,
    ...(usageLimit === undefined ? {} : { usageLimit }),
  };
}
