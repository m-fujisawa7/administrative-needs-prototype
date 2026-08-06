import type { NotionConnectionReport } from './types.ts';

export function formatNotionConnectionReport(report: NotionConnectionReport): string {
  const lines = [
    'Notion connection check completed.',
    '',
    'Database:',
    `Name: ${report.databaseName}`,
    `ID: ${report.databaseId}`,
    '',
    `Data sources: ${report.dataSources.length}`,
  ];

  for (const dataSource of report.dataSources) {
    lines.push(
      '',
      'Data source:',
      `Name: ${dataSource.name}`,
      `ID: ${dataSource.id}`,
      '',
      'Properties:',
    );
    if (dataSource.properties.length === 0) {
      lines.push('- (none)');
    } else {
      for (const property of dataSource.properties) {
        lines.push(`- ${property.name} (ID: ${property.id}): ${property.type}`);
      }
    }
  }

  if (report.dataSources.length > 1) {
    lines.push(
      '',
      'Warning: Multiple data sources were found.',
      'Select a data source before implementing page creation.',
    );
  } else {
    lines.push(
      '',
      `Registration candidate data source ID: ${report.dataSources[0]!.id}`,
    );
  }

  lines.push(
    '',
    'Result:',
    'Connection successful.',
    'Read access confirmed.',
    'No data was written.',
  );
  return lines.join('\n');
}
