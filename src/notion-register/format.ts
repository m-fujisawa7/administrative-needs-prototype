import type {
  CreatedNotionPage,
  ExistingNotionPage,
  NotionRegistrationPreview,
} from './types.ts';

export function formatNotionDuplicateSkip(
  officialUrl: string,
  page: ExistingNotionPage,
): string {
  return [
    'Duplicate page found.',
    '',
    'Duplicate:',
    'Yes',
    '',
    'Official URL:',
    officialUrl,
    '',
    'Existing page ID:',
    page.id,
    '',
    'Existing page URL:',
    page.url,
    '',
    'Content fetch:',
    'Skipped',
    '',
    'PDF extraction:',
    'Skipped',
    '',
    'Claude analysis:',
    'Skipped',
    '',
    'Registration:',
    'Skipped',
  ].join('\n');
}

export function formatNotionRegistrationPreview(
  preview: NotionRegistrationPreview,
): string {
  const values = preview.values;
  const lines = [
    'Notion registration preview.',
    '',
    'Write mode:',
    preview.write ? 'Enabled' : 'Disabled',
    '',
    'Database:',
    preview.databaseName,
    '',
    'Data source:',
    preview.dataSource.name,
    '',
    'Schema:',
    'Matched',
    '',
    'Source:',
    `${values.organizationName} / ${preview.sourceId}`,
    '',
    'Title:',
    values.title,
    '',
    'Official URL:',
    values.officialUrl,
    '',
    'Target:',
    values.target,
    '',
    'Document type:',
    values.documentType,
    '',
    'Problem:',
    values.problem || '(empty)',
    '',
    'Desired state:',
    values.desiredState || '(empty)',
    '',
    'Request to private sector:',
    values.requestToPrivateSector || '(empty)',
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
    'Reason:',
    values.reason,
    '',
    'Evidence:',
    values.evidence,
    '',
    'Confirmation status:',
    values.confirmationStatus,
    '',
    'Duplicate:',
    preview.duplicate === null ? 'No' : 'Yes',
    '',
    'Select option safety:',
    preview.missingOptions.length === 0 ? 'Ready' : 'Blocked',
  ];
  if (preview.missingOptions.length > 0) {
    lines.push(
      '',
      'Missing existing options:',
      ...preview.missingOptions.map(
        (missing) => `- ${missing.propertyName}: ${missing.optionName}`,
      ),
      '',
      'Creating these options through page creation could change the data source schema.',
    );
  }
  if (preview.duplicate !== null) {
    lines.push(
      '',
      'Registration skipped.',
      '',
      'Reason:',
      'A page with the same official URL already exists.',
      '',
      'Existing page ID:',
      preview.duplicate.id,
      '',
      'Existing page URL:',
      preview.duplicate.url,
    );
  } else if (!preview.write) {
    lines.push(
      '',
      'No data was written.',
      preview.missingOptions.length === 0
        ? 'Run again with --write to create one Notion page.'
        : 'Add the missing options in Notion before running with --write.',
    );
  }
  return lines.join('\n');
}

export function formatNotionRegistrationCompleted(
  preview: NotionRegistrationPreview,
  page: CreatedNotionPage,
): string {
  return [
    'Notion registration completed.',
    '',
    'Title:',
    preview.values.title,
    '',
    'Official URL:',
    preview.values.officialUrl,
    '',
    'Notion page ID:',
    page.id,
    '',
    'Notion page URL:',
    page.url,
    '',
    'Result:',
    'One page was created.',
  ].join('\n');
}
