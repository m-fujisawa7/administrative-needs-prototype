import type {
  CollectionRunItemResult,
  CollectionRunReport,
} from './types.ts';

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
    'Candidates collected:',
    String(report.candidatesCollected),
    '',
    'Unique candidates:',
    String(report.uniqueCandidates),
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
  return lines.join('\n');
}
