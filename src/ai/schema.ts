import { z } from 'zod';
import {
  AI_CATEGORIES,
  COMPANY_RELEVANCE_VALUES,
  CONTACT_RECOMMENDATION_VALUES,
  DOCUMENT_TYPES,
  type AdministrativeNeedAnalysis,
} from './types.ts';

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'source_url は http または https にしてください。');

const evidenceQuoteSchema = z.strictObject({
  source_type: z.enum(['html', 'pdf']),
  source_url: httpUrlSchema,
  quote: z.string().trim().min(1).max(500),
});

export const administrativeNeedAnalysisSchema = z.strictObject({
  is_target: z.boolean(),
  document_type: z.enum(DOCUMENT_TYPES),
  problem_summary: z.string().trim().max(2_000),
  desired_state: z.string().trim().max(2_000),
  request_to_private_sector: z.string().trim().max(2_000),
  categories: z.array(z.enum(AI_CATEGORIES)).max(10),
  company_relevance: z.enum(COMPANY_RELEVANCE_VALUES),
  contact_recommendation: z.enum(CONTACT_RECOMMENDATION_VALUES),
  reason: z.string().trim().min(1).max(2_000),
  evidence_quotes: z.array(evidenceQuoteSchema).min(1).max(5),
}).superRefine((analysis, context) => {
  if (!analysis.is_target) {
    if (analysis.company_relevance !== 'out_of_scope') {
      context.addIssue({
        code: 'custom',
        path: ['company_relevance'],
        message: 'is_target=false の場合は out_of_scope にしてください。',
      });
    }
    if (analysis.contact_recommendation !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['contact_recommendation'],
        message: 'is_target=false の場合は none にしてください。',
      });
    }
  }
  if (
    analysis.company_relevance === 'out_of_scope'
    && analysis.contact_recommendation !== 'none'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['contact_recommendation'],
      message: 'company_relevance=out_of_scope の場合は none にしてください。',
    });
  }
  if (
    analysis.contact_recommendation === 'high'
    && analysis.company_relevance !== 'A'
    && analysis.company_relevance !== 'B'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['contact_recommendation'],
      message: 'high は company_relevance が A または B の場合だけ使用できます。',
    });
  }
});

export function parseAdministrativeNeedAnalysis(input: unknown): AdministrativeNeedAnalysis {
  return administrativeNeedAnalysisSchema.parse(input);
}

export function administrativeNeedJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(administrativeNeedAnalysisSchema, {
    target: 'draft-07',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}
