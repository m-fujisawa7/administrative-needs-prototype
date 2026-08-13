import type {
  NotionBatchItemResult,
  NotionBatchReport,
} from './types.ts';

export function formatNotionBatchItem(
  result: NotionBatchItemResult,
  index: number,
  total: number,
): string {
  const prefix = `[${index}/${total}]`;
  if (result.status === 'input_duplicate') {
    return [
      `${prefix} Input duplicate skipped`,
      '',
      'Official URL:',
      result.officialUrl,
      '',
      'Reason:',
      'The same URL already appeared earlier in the input file.',
    ].join('\n');
  }
  if (result.status === 'duplicate') {
    const preflight = result.phase === 'preflight';
    return [
      `${prefix} Duplicate skipped`,
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
      'Select option safety:',
      result.preview.missingOptions.length === 0 ? 'Ready' : 'Blocked',
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

export function formatNotionBatchSummary(report: NotionBatchReport): string {
  const count = (status: NotionBatchItemResult['status']): number =>
    report.results.filter((result) => result.status === status).length;
  const failures = report.results.filter((result) => result.status === 'failed');
  const lines = [
    'Batch completed.',
    '',
    'Mode:',
    report.write ? 'Write' : 'Preview',
    '',
    'Input lines:',
    String(report.inputLines),
    'Valid unique URLs:',
    String(report.validUniqueUrls),
    '',
    'Previewed:',
    String(count('previewed')),
    'Created:',
    String(count('created')),
    'Duplicates skipped:',
    String(count('duplicate')),
    'Input duplicates skipped:',
    String(count('input_duplicate')),
    'Failed:',
    String(count('failed')),
  ];
  if (failures.length > 0) {
    lines.push('', 'Failures:', '');
    for (const failure of failures) {
      lines.push(
        `- ${failure.officialUrl}`,
        `  Stage: ${failure.stage}`,
        `  Message: ${failure.message}`,
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
      'Remaining URLs were not sent to Claude.',
    );
  }
  return lines.join('\n');
}
