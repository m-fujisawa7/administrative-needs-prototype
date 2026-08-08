import { countWarningsBySeverity } from '../ai/warning-severity.ts';
import type { AdministrativeNeedAnalysis } from '../ai/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import type {
  SourceVerifyCliOptions,
  SourceVerifyItemResult,
  SourceVerifyReport,
} from './types.ts';

export function formatSourceVerificationStarted(
  source: Source,
  organization: Organization,
  options: SourceVerifyCliOptions,
): string {
  return [
    'Source verification started.',
    '',
    'Source:',
    source.id,
    '',
    'Municipality:',
    organization.name,
    '',
    'Source URL:',
    source.url,
    '',
    'Sample limit:',
    String(options.limit),
  ].join('\n');
}

export function formatSourceVerificationCandidates(
  candidates: Array<{ title: string; url: string }>,
  samplesSelected: number,
): string {
  const lines = [
    'Source connection:',
    'OK',
    '',
    `Candidates found: ${candidates.length}`,
  ];
  for (const [index, candidate] of candidates.entries()) {
    lines.push('', `${index + 1}. ${candidate.title || 'Unknown'}`, `   ${candidate.url}`);
  }
  lines.push('', `Samples selected: ${samplesSelected}`);
  return lines.join('\n');
}

export function formatSourceVerificationItem(
  item: SourceVerifyItemResult,
  index: number,
  total: number,
): string {
  const prefix = `[${index}/${total}]`;
  if (item.status === 'failed') {
    const contentSucceeded = item.stage === 'ai' && item.content !== undefined;
    return [
      `${prefix} Verification failed`,
      '',
      'Title:',
      item.candidate.title || 'Unknown',
      '',
      'URL:',
      item.candidate.url,
      '',
      'Content check:',
      contentSucceeded ? 'OK' : 'Failed',
      ...(contentSucceeded ? [
        '',
        'HTML characters:',
        String(item.content!.htmlCharacters),
        '',
        'PDF attachments:',
        String(item.content!.pdfDiscovered),
        '',
        'PDF extracted:',
        String(item.content!.pdfExtracted),
        '',
        'PDF characters:',
        String(item.content!.pdfCharacters),
      ] : [
        '',
        'PDF extraction:',
        'Skipped',
      ]),
      '',
      'AI analysis:',
      item.stage === 'ai' ? 'Failed' : 'Skipped',
      '',
      'Error:',
      item.message,
    ].join('\n');
  }

  const { result } = item;
  const summary = result.inputSummary;
  return [
    `${prefix} Verification completed`,
    '',
    'Title:',
    result.title,
    '',
    'URL:',
    result.officialUrl,
    '',
    'Content check:',
    'OK',
    '',
    'HTML characters:',
    String(summary.htmlOriginalCharacters),
    '',
    'PDF attachments:',
    String(summary.pdfDiscovered),
    '',
    'PDF extraction:',
    pdfStatus(summary.pdfDiscovered, summary.pdfAttempted, summary.pdfIncluded),
    '',
    'PDF documents extracted:',
    `${summary.pdfIncluded}/${summary.pdfDiscovered}`,
    '',
    'PDF characters:',
    String(summary.pdfOriginalCharacters),
    '',
    'AI analysis:',
    'OK',
    '',
    ...formatAnalysis(result.analysis),
    '',
    'Evidence matched:',
    `${result.evidenceMatched}/${result.analysis.evidence_quotes.length}`,
    '',
    'Notices:',
    String(countWarningsBySeverity(result.warnings).notices),
    '',
    'Warnings:',
    String(countWarningsBySeverity(result.warnings).warnings),
  ].join('\n');
}

export function formatSourceVerificationSummary(report: SourceVerifyReport): string {
  const contentSucceeded = report.results.filter(
    (item) => item.status === 'succeeded' || item.stage === 'ai',
  ).length;
  const contentFailed = report.results.filter(
    (item) => item.status === 'failed' && item.stage === 'content',
  ).length;
  const aiSucceeded = report.results.filter((item) => item.status === 'succeeded').length;
  const aiFailed = report.results.filter(
    (item) => item.status === 'failed' && item.stage === 'ai',
  ).length;
  const ready = report.results.length > 0
    && report.results.every((item) => item.status === 'succeeded');
  return [
    'Source verification completed.',
    '',
    'Source:',
    report.sourceId,
    '',
    'Candidates found:',
    String(report.candidatesFound),
    '',
    'Samples checked:',
    String(report.results.length),
    '',
    'Content succeeded:',
    String(contentSucceeded),
    '',
    'Content failed:',
    String(contentFailed),
    '',
    'AI analysis succeeded:',
    String(aiSucceeded),
    '',
    'AI analysis failed:',
    String(aiFailed),
    '',
    'Notion write:',
    'Skipped',
    '',
    'Collection state:',
    'Unchanged',
    '',
    'Ready for collection:',
    ready ? 'YES' : 'CHECK REQUIRED',
  ].join('\n');
}

function formatAnalysis(analysis: AdministrativeNeedAnalysis): string[] {
  return [
    'Target:',
    String(analysis.is_target),
    '',
    'Document type:',
    analysis.document_type,
    '',
    'Problem summary:',
    analysis.problem_summary || 'Not found',
    '',
    'Desired state:',
    analysis.desired_state || 'Not found',
    '',
    'Request to private sector:',
    analysis.request_to_private_sector || 'Not found',
    '',
    'Categories:',
    ...(analysis.categories.length === 0
      ? ['(none)']
      : analysis.categories.map((category) => `- ${category}`)),
    '',
    'Company relevance:',
    analysis.company_relevance,
    '',
    'Contact recommendation:',
    analysis.contact_recommendation,
    '',
    'Reason:',
    analysis.reason,
    '',
    'Evidence quotes:',
    ...analysis.evidence_quotes.flatMap((evidence) => [
      `- [${evidence.source_type}] ${evidence.quote}`,
      `  ${evidence.source_url}`,
    ]),
  ];
}

function pdfStatus(discovered: number, attempted: number, included: number): string {
  if (discovered === 0) return 'Not applicable';
  return discovered === attempted && attempted === included ? 'OK' : 'Partial';
}
