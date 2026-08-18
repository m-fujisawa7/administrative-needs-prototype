import type {
  Organization,
  SourceRegistry,
} from '../source-registry/schema.ts';

export type PublicSourceStatus = 'active' | 'inactive';

export type PublicSource = {
  name: string;
  url: string;
  status: PublicSourceStatus;
};

export type PublicOrganization = {
  name: string;
  sources: PublicSource[];
};

export type PublicSourceList = {
  prefectures: PublicOrganization[];
  municipalities: PublicOrganization[];
  organizationCount: number;
  sourceCount: number;
  activeSourceCount: number;
};

type PublicSection = 'prefectures' | 'municipalities';

const PREFECTURE_TYPES = new Set<Organization['organization_type']>([
  'prefecture',
]);

const MUNICIPALITY_TYPES = new Set<Organization['organization_type']>([
  'designated_city',
  'municipality',
  'special_ward',
]);

/**
 * 検証済み台帳から、公開可能な最小項目だけを取り出す。
 * 分類は組織の親子関係とorganization_typeだけで行い、名称から推測しない。
 */
export function createPublicSourceList(registry: SourceRegistry): PublicSourceList {
  const organizationsById = new Map(
    registry.organizations.map((organization) => [organization.id, organization]),
  );
  const grouped = {
    prefectures: new Map<string, PublicOrganization>(),
    municipalities: new Map<string, PublicOrganization>(),
  };

  for (const source of registry.sources) {
    const owner = organizationsById.get(source.organization_id);
    if (owner === undefined) {
      throw new Error(`Source ${source.id} has no organization.`);
    }
    const root = findRootOrganization(owner, organizationsById);
    const section = classifyRootOrganization(root);
    const organization = grouped[section].get(root.id) ?? {
      name: root.name,
      sources: [],
    };
    organization.sources.push({
      name: source.name,
      url: source.url,
      status: source.enabled ? 'active' : 'inactive',
    });
    grouped[section].set(root.id, organization);
  }

  const sortOrganizations = (organizations: Map<string, PublicOrganization>) =>
    [...organizations.values()]
      .map((organization) => ({
        ...organization,
        sources: organization.sources.toSorted(comparePublicSources),
      }))
      .toSorted((left, right) => compareJapanese(left.name, right.name));

  const prefectures = sortOrganizations(grouped.prefectures);
  const municipalities = sortOrganizations(grouped.municipalities);
  const allOrganizations = [...prefectures, ...municipalities];

  return {
    prefectures,
    municipalities,
    organizationCount: allOrganizations.length,
    sourceCount: allOrganizations.reduce(countSources, 0),
    activeSourceCount: allOrganizations.reduce(countActiveSources, 0),
  };
}

function findRootOrganization(
  organization: Organization,
  organizationsById: ReadonlyMap<string, Organization>,
): Organization {
  const visited = new Set<string>();
  let current = organization;

  while (current.parent_organization_id !== undefined) {
    if (visited.has(current.id)) {
      throw new Error(`Organization hierarchy contains a cycle at ${current.id}.`);
    }
    visited.add(current.id);
    const parent = organizationsById.get(current.parent_organization_id);
    if (parent === undefined) {
      throw new Error(`Organization ${current.id} has an unknown parent.`);
    }
    current = parent;
  }

  return current;
}

function classifyRootOrganization(organization: Organization): PublicSection {
  if (PREFECTURE_TYPES.has(organization.organization_type)) {
    return 'prefectures';
  }
  if (MUNICIPALITY_TYPES.has(organization.organization_type)) {
    return 'municipalities';
  }
  throw new Error(
    `Organization ${organization.id} cannot be classified for the public source list.`,
  );
}

function comparePublicSources(left: PublicSource, right: PublicSource): number {
  return compareStatus(left, right)
    || compareJapanese(left.name, right.name)
    || left.url.localeCompare(right.url);
}

function compareStatus(left: PublicSource, right: PublicSource): number {
  if (left.status === right.status) return 0;
  return left.status === 'active' ? -1 : 1;
}

function compareJapanese(left: string, right: string): number {
  return left.localeCompare(right, 'ja');
}

function countSources(total: number, organization: PublicOrganization): number {
  return total + organization.sources.length;
}

function countActiveSources(total: number, organization: PublicOrganization): number {
  return total + organization.sources.filter((source) => source.status === 'active').length;
}
