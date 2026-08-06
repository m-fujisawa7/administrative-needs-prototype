import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { AiConfigurationError } from './errors.ts';
import type { CompanyFitCriteria } from './types.ts';

export const DEFAULT_COMPANY_FIT_CRITERIA_PATH = 'config/company-fit-criteria.yaml';

const companyFitCriteriaSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().trim().min(1),
  direct_fit: z.array(z.string().trim().min(1)).min(1),
  partner_fit: z.array(z.string().trim().min(1)).min(1),
  strategic_interest: z.array(z.string().trim().min(1)).min(1),
  out_of_scope: z.array(z.string().trim().min(1)).min(1),
  notes: z.string().trim().min(1).optional(),
});

export async function loadCompanyFitCriteria(
  path = process.env.AI_COMPANY_FIT_CRITERIA_PATH ?? DEFAULT_COMPANY_FIT_CRITERIA_PATH,
): Promise<CompanyFitCriteria> {
  const absolutePath = resolve(path);
  let source: string;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AiConfigurationError(
      `自社適合度判定基準を読み込めません: ${absolutePath}: ${detail}`,
    );
  }

  const parsed = companyFitCriteriaSchema.safeParse(parse(source));
  if (!parsed.success) {
    throw new AiConfigurationError(
      `自社適合度判定基準が不正です: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    version: 1,
    name: parsed.data.name,
    directFit: parsed.data.direct_fit,
    partnerFit: parsed.data.partner_fit,
    strategicInterest: parsed.data.strategic_interest,
    outOfScope: parsed.data.out_of_scope,
    ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
  };
}
