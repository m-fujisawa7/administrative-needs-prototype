import type {
  CollectionRunCliOptions,
  CollectionRunItemResult,
  CollectionRunReport,
} from './types.ts';
import {
  COLLECTION_LOOKBACK_DAYS,
  INITIAL_COLLECTION_SINCE,
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
    lines.push('', 'Initial collection since:', INITIAL_COLLECTION_SINCE);
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
