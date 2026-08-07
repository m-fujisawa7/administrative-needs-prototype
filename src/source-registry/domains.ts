import type { Organization, SourceRegistry } from './schema.ts';

/**
 * 添付ファイル取得時にだけ追加で許可する公式ドメインを返す。
 *
 * `parent_organization_id` を辿り、祖先組織の `official_domain` を親から順に返す。
 * 組織自身の `official_domain` は呼び出し側が既に許可しているため含めない。
 * 親を持たない組織では空配列を返すので、既存の挙動が変わらない。
 *
 * 収集対象そのものを広げないため、この結果は記事本文から見つけた添付PDFの取得に
 * だけ使う。一覧ページ・RSSからの候補抽出と記事HTML取得には使わない。
 */
export function getTrustedAttachmentDomains(
  registry: Pick<SourceRegistry, 'organizations'>,
  organization: Organization,
): string[] {
  const byId = new Map(registry.organizations.map((candidate) => [candidate.id, candidate]));
  const domains: string[] = [];
  const visited = new Set<string>([organization.id]);

  let current = organization;
  while (current.parent_organization_id !== undefined) {
    const parentId = current.parent_organization_id;
    // 循環参照と自己参照で無限ループしないように、辿った組織を記録する。
    if (visited.has(parentId)) break;
    visited.add(parentId);

    const parent = byId.get(parentId);
    if (parent === undefined) break;

    const domain = parent.official_domain;
    if (domain !== organization.official_domain && !domains.includes(domain)) {
      domains.push(domain);
    }
    current = parent;
  }

  return domains;
}
