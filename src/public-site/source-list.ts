import type {
  Organization,
  SourceRegistry,
} from '../source-registry/schema.ts';
import {
  findPrefectureLocation,
  PUBLIC_REGIONS,
  type PublicRegionId,
} from './geography.ts';

export type PublicSourceStatus = 'active' | 'inactive';

export type PublicSource = {
  name: string;
  url: string;
  status: PublicSourceStatus;
};

export type PublicOrganization = {
  id: string;
  name: string;
  sources: PublicSource[];
};

export type PublicAdministrativeLayerId = 'prefecture' | 'municipality';

export type PublicAdministrativeLayer = {
  id: PublicAdministrativeLayerId;
  name: string;
  organizations: PublicOrganization[];
};

export type PublicRegion = {
  id: PublicRegionId;
  name: string;
  layers: PublicAdministrativeLayer[];
};

export type PublicSourceList = {
  regions: PublicRegion[];
  organizationCount: number;
  sourceCount: number;
  activeSourceCount: number;
};

const PREFECTURE_TYPES = new Set<Organization['organization_type']>([
  'prefecture',
]);

const MUNICIPALITY_TYPES = new Set<Organization['organization_type']>([
  'designated_city',
  'municipality',
  'special_ward',
]);

const ADMINISTRATIVE_LAYERS = [
  { id: 'prefecture', name: '都道府県' },
  { id: 'municipality', name: '市区町村' },
] as const satisfies readonly Omit<PublicAdministrativeLayer, 'organizations'>[];

/**
 * 検証済み台帳から、公開可能な最小項目だけを取り出す。
 * 地域・自治体分類は親子関係、organization_type、prefectureで行い、名称から推測しない。
 */
export function createPublicSourceList(registry: SourceRegistry): PublicSourceList {
  const organizationsById = new Map(
    registry.organizations.map((organization) => [organization.id, organization]),
  );
  const organizationOrderById = new Map(
    registry.organizations.map((organization, index) => [organization.id, index]),
  );
  const grouped = new Map<string, GroupedOrganization>();

  for (const source of registry.sources) {
    const owner = organizationsById.get(source.organization_id);
    if (owner === undefined) {
      throw new Error(`Source ${source.id} has no organization.`);
    }
    const root = findRootOrganization(owner, organizationsById);
    const kind = classifyRootOrganization(root);
    const prefecture = requirePrefecture(root);
    const location = findPrefectureLocation(prefecture);
    if (location === undefined) {
      throw new Error(
        `Organization ${root.id} has an unknown prefecture for the public source list: ${prefecture}.`,
      );
    }
    const organization = grouped.get(root.id) ?? {
      id: root.id,
      name: root.name,
      sources: [],
      kind,
      regionId: location.regionId,
      prefectureOrder: location.prefectureOrder,
      registrationOrder: organizationOrderById.get(root.id) ?? Number.MAX_SAFE_INTEGER,
    };
    organization.sources.push({
      name: source.name,
      url: source.url,
      status: source.enabled ? 'active' : 'inactive',
    });
    grouped.set(root.id, organization);
  }

  const regions = PUBLIC_REGIONS.map((region): PublicRegion => ({
    id: region.id,
    name: region.name,
    layers: ADMINISTRATIVE_LAYERS.map((layer) => ({
      ...layer,
      organizations: [...grouped.values()]
        .filter((organization) => (
          organization.regionId === region.id && organization.kind === layer.id
        ))
        .toSorted(compareOrganizations)
        .map(({ id, name, sources }) => ({
          id,
          name,
          sources: sources.toSorted(comparePublicSources),
        })),
    })),
  }));
  const allOrganizations = regions.flatMap((region) => (
    region.layers.flatMap((layer) => layer.organizations)
  ));

  return {
    regions,
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

type PublicOrganizationKind = PublicAdministrativeLayerId;

type GroupedOrganization = PublicOrganization & {
  kind: PublicOrganizationKind;
  regionId: PublicRegionId;
  prefectureOrder: number;
  registrationOrder: number;
};

function classifyRootOrganization(organization: Organization): PublicOrganizationKind {
  if (PREFECTURE_TYPES.has(organization.organization_type)) {
    return 'prefecture';
  }
  if (MUNICIPALITY_TYPES.has(organization.organization_type)) {
    return 'municipality';
  }
  throw new Error(
    `Organization ${organization.id} cannot be classified for the public source list.`,
  );
}

function requirePrefecture(organization: Organization): string {
  if (organization.prefecture === undefined) {
    throw new Error(
      `Organization ${organization.id} has no prefecture for the public source list.`,
    );
  }
  return organization.prefecture;
}

function compareOrganizations(left: GroupedOrganization, right: GroupedOrganization): number {
  return left.prefectureOrder - right.prefectureOrder
    || left.registrationOrder - right.registrationOrder;
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
