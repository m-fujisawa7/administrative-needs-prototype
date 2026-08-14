import { aiInputSection } from '../ai/input.ts';
import type { CollectionBatchReport } from './batch.ts';
import type {
  ClaudeUsageLimitStop,
  CollectionRunCliOptions,
  CollectionRunItemResult,
  CollectionRunReport,
} from './types.ts';
import {
  COLLECTION_LOOKBACK_DAYS,
  type CollectionPeriod,
} from './state.ts';

export function formatCollectionRunStarted(
  options: CollectionRunCliOptions,
  period: CollectionPeriod,
): string {
  const lines = [
    'Collection started.',
    '',
    'Source:',
    options.sourceId,
    '',
    'Run started at:',
    period.runStartedAt,
    '',
    'Previous successful check:',
    period.previousSuccessfulCheck ?? 'None',
  ];
  if (period.previousSuccessfulCheck === null) {
    lines.push('', 'Initial collection since:', period.initialCollectionSince);
  } else if (!period.usedManualSince) {
    lines.push('', 'Lookback:', `${COLLECTION_LOOKBACK_DAYS} days`);
  }
  lines.push(
    '',
    'Effective since:',
    period.effectiveSince,
    '',
    'Limit:',
    String(options.limit),
  );
  return lines.join('\n');
}

/**
 * 利用上限で停止したことを1目で分かる形にする。
 *
 * raw stdout全体は出さず、Claude CLIが返した利用上限メッセージだけを見せる。
 */
export function formatClaudeUsageLimitStop(stop: ClaudeUsageLimitStop): string {
  return [
    '[ERROR] Claude CLI usage limit reached.',
    stop.message,
    '',
    'AI processing has been stopped for the rest of this run.',
  ].join('\n');
}

export function formatCollectionRunItem(
  item: CollectionRunItemResult,
  index: number,
  total: number,
): string {
  const { candidate, result } = item;
  const prefix = `[${index}/${total}]`;
  if (result.status === 'duplicate') {
    const preflight = result.phase === 'preflight';
    return [
      `${prefix} Duplicate skipped`,
      '',
      'Title:',
      candidate.title || 'Unknown',
      '',
      'Official URL:',
      result.officialUrl,
      '',
      'Existing page ID:',
      result.existingPageId,
      '',
      'Existing page URL:',
      result.existingPageUrl,
      '',
      'Content fetch:',
      preflight ? 'Skipped' : 'Completed before the final duplicate check',
      '',
      'PDF extraction:',
      preflight ? 'Skipped' : 'Completed before the final duplicate check',
      '',
      'Claude analysis:',
      preflight ? 'Skipped' : 'Completed before the final duplicate check',
      '',
      'Registration:',
      'Skipped',
    ].join('\n');
  }
  if (result.status === 'previewed') {
    const values = result.preview.values;
    return [
      `${prefix} Preview completed`,
      '',
      'Title:',
      result.title,
      '',
      'Official URL:',
      result.officialUrl,
      '',
      'Target:',
      values.target,
      '',
      'Document type:',
      values.documentType,
      '',
      'Categories:',
      ...(values.categories.length === 0
        ? ['(none)']
        : values.categories.map((category) => `- ${category}`)),
      '',
      'Company relevance:',
      values.companyRelevance,
      '',
      'Contact recommendation:',
      values.contactRecommendation,
      '',
      'Notion write:',
      'Skipped',
      ...aiInputSection(result),
    ].join('\n');
  }
  if (result.status === 'created') {
    return [
      `${prefix} Created`,
      '',
      'Title:',
      result.title,
      '',
      'Official URL:',
      result.officialUrl,
      '',
      'Notion page ID:',
      result.notionPageId,
      '',
      'Notion page URL:',
      result.notionPageUrl,
      ...aiInputSection(result),
    ].join('\n');
  }
  const lines = [
    `${prefix} Failed`,
    '',
    'Official URL:',
    result.officialUrl,
    '',
    'Stage:',
    result.stage,
    '',
    'Message:',
    result.message,
  ];
  if (result.preview !== undefined && result.preview.missingOptions.length > 0) {
    lines.push(
      '',
      'Missing existing options:',
      ...result.preview.missingOptions.map(
        (missing) => `- ${missing.propertyName}: ${missing.optionName}`,
      ),
    );
  }
  return lines.join('\n');
}

export function formatCollectionRunSummary(report: CollectionRunReport): string {
  const count = (status: CollectionRunItemResult['result']['status']): number =>
    report.results.filter((item) => item.result.status === status).length;
  const failures = report.results.filter((item) => item.result.status === 'failed');
  const lines = [
    'Collection run completed.',
    '',
    'Mode:',
    report.write ? 'Write' : 'Preview',
    '',
    'Source:',
    report.sourceId,
    '',
    'Period:',
    report.effectiveSince,
    'to',
    report.runStartedAt,
    '',
    'Candidates collected:',
    String(report.candidatesCollected),
    '',
    'Unique candidates:',
    String(report.uniqueCandidates),
    '',
    'Candidates in period:',
    String(report.candidatesInPeriod),
    '',
    'New candidates found:',
    String(report.newCandidatesFound),
    '',
    'Processed new candidates:',
    String(report.processedNewCandidates),
    '',
    'Previewed:',
    String(count('previewed')),
    '',
    'Created:',
    String(count('created')),
    '',
    'Duplicates skipped:',
    String(count('duplicate')),
    '',
    'Failed:',
    String(count('failed')),
    '',
    'Remaining new candidates:',
    String(report.remainingNewCandidates),
  ];
  if (failures.length > 0) {
    lines.push('', 'Failures:', '');
    for (const { result } of failures) {
      if (result.status !== 'failed') continue;
      lines.push(
        `- ${result.officialUrl}`,
        `  Stage: ${result.stage}`,
        `  Message: ${result.message}`,
      );
    }
  }
  if (report.usageLimit !== undefined) {
    lines.push(
      '',
      'Stopped:',
      'Claude CLI usage limit reached.',
      report.usageLimit.message,
      '',
      'Remaining candidates were not sent to Claude.',
    );
  }
  lines.push(
    '',
    'Collection state:',
    report.collectionState.status === 'advanced' ? 'Advanced' : 'Not advanced',
  );
  if (report.collectionState.status === 'advanced') {
    lines.push(
      '',
      'New last successful check:',
      report.collectionState.newLastSuccessfulCheck,
    );
  } else {
    lines.push('', 'Reason:', report.collectionState.reason);
  }
  return lines.join('\n');
}

const BATCH_COLUMNS = [
  { header: 'Source', align: 'left' as const },
  { header: 'Created', align: 'right' as const },
  { header: 'Previewed', align: 'right' as const },
  { header: 'Duplicates', align: 'right' as const },
  { header: 'Failed', align: 'right' as const },
  { header: 'Remaining', align: 'right' as const },
  { header: 'State', align: 'left' as const },
];

/** Sourceごとの結果を一目で比較できる表を作る。 */
export function formatCollectionBatchSummary(report: CollectionBatchReport): string {
  const rows = report.outcomes.map((outcome) => [
    outcome.sourceId,
    String(outcome.created),
    String(outcome.previewed),
    String(outcome.duplicates),
    String(outcome.failed),
    String(outcome.remaining),
    outcome.state,
  ]);
  const widths = BATCH_COLUMNS.map((column, index) => Math.max(
    column.header.length,
    ...rows.map((row) => (row[index] ?? '').length),
  ));
  const renderRow = (cells: readonly string[]): string => cells
    .map((cell, index) => (BATCH_COLUMNS[index]?.align === 'right'
      ? cell.padStart(widths[index] ?? 0)
      : cell.padEnd(widths[index] ?? 0)))
    .join('  ')
    .trimEnd();

  const lines = [
    'Batch collection completed.',
    '',
    'Mode:',
    report.write ? 'Write' : 'Preview',
    '',
    'Sources selected:',
    String(report.sourcesSelected),
    '',
    renderRow(BATCH_COLUMNS.map((column) => column.header)),
    ...rows.map(renderRow),
  ];

  const withReason = report.outcomes.filter((outcome) => outcome.reason !== undefined);
  if (withReason.length > 0) {
    lines.push('', 'State details:');
    for (const outcome of withReason) {
      lines.push(`- ${outcome.sourceId}: ${outcome.state} (${outcome.reason ?? ''})`);
    }
  }

  lines.push(
    '',
    'Totals:',
    `Created: ${report.totals.created}`,
    `Previewed: ${report.totals.previewed}`,
    `Duplicates skipped: ${report.totals.duplicates}`,
    `Failed: ${report.totals.failed}`,
    `Remaining new candidates: ${report.totals.remaining}`,
  );
  if (report.stopped !== undefined) {
    const notRun = report.sourcesSelected - report.outcomes.length;
    lines.push(
      '',
      'Batch stopped:',
      'Claude CLI usage limit reached.',
      report.stopped.message,
      '',
      'Collection state:',
      'Not advanced for the interrupted source.',
      '',
      'Sources not started:',
      String(notRun),
    );
  }
  return lines.join('\n');
}
