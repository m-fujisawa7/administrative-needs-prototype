import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AdministrativeNeedAnalyzer,
} from './types.ts';

export class MockAnalyzer implements AdministrativeNeedAnalyzer {
  readonly provider = 'mock' as const;
  readonly model = null;

  async analyze(input: AdministrativeNeedAnalysisInput): Promise<AdministrativeNeedAnalysis> {
    const quote = firstEvidenceQuote(input.htmlText);
    return {
      is_target: true,
      document_type: 'rfi',
      problem_summary: '市民向け行政サービスを利用者視点で改善するための知見や実施方法が不足している。',
      desired_state: '利用者視点で行政サービスを継続的に設計・改善できる状態。',
      request_to_private_sector: 'サービスデザインの手法、事例、実施体制などに関する情報提供。',
      categories: ['サービスデザイン', '行政DX', 'UI・UX'],
      company_relevance: 'A',
      contact_recommendation: 'high',
      reason: '民間事業者から情報提供を求めている段階であり、対話や提案の余地がある。',
      evidence_quotes: [{
        source_type: 'html',
        source_url: input.officialUrl,
        quote,
      }],
    };
  }
}

function firstEvidenceQuote(value: string): string {
  const line = value
    .split(/\n/gu)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length >= 10);
  return (line ?? value.trim()).slice(0, 120);
}
