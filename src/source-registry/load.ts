import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  validateSourceRegistry,
  type Organization,
  type Source,
  type SourceRegistry,
} from './schema.ts';

export const DEFAULT_SOURCE_REGISTRY_PATH = fileURLToPath(
  new URL('../../config/sources.yaml', import.meta.url),
);

export async function loadSourceRegistry(
  filePath = DEFAULT_SOURCE_REGISTRY_PATH,
): Promise<SourceRegistry> {
  const yaml = await readFile(filePath, 'utf8');
  return validateSourceRegistry(parse(yaml));
}

export function getEnabledSources(registry: SourceRegistry): Source[] {
  const enabledOrganizations = new Set(
    registry.organizations
      .filter((organization) => organization.enabled)
      .map((organization) => organization.id),
  );
  return registry.sources.filter(
    (source) => source.enabled && enabledOrganizations.has(source.organization_id),
  );
}

export function getSourcesByOrganization(
  registry: SourceRegistry,
  organizationId: string,
): Source[] {
  return registry.sources.filter((source) => source.organization_id === organizationId);
}

/**
 * 自治体名に属する収集対象のSourceを返す。
 *
 * 組織自身の name に加えて parent_organization_id を辿った祖先の name も照合する。
 * 外郭団体を別組織として登録している場合（Hatch Technology NAGOYA など）でも
 * 親自治体を指定して選択できる。判定は getEnabledSources と同じ有効判定を通す。
 */
export function getSourcesByMunicipality(
  registry: SourceRegistry,
  municipalityName: string,
): Source[] {
  const byId = new Map(registry.organizations.map((organization) => [
    organization.id,
    organization,
  ]));

  const belongsToMunicipality = (organization: Organization): boolean => {
    const visited = new Set<string>();
    let current: Organization | undefined = organization;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.name === municipalityName) return true;
      current = current.parent_organization_id === undefined
        ? undefined
        : byId.get(current.parent_organization_id);
    }
    return false;
  };

  const matched = new Set(
    registry.organizations
      .filter((organization) => belongsToMunicipality(organization))
      .map((organization) => organization.id),
  );
  return getEnabledSources(registry).filter((source) => matched.has(source.organization_id));
}

/** 台帳に登録されている自治体・組織名の一覧。エラーメッセージの候補表示に使う。 */
export function listOrganizationNames(registry: SourceRegistry): string[] {
  return [...new Set(registry.organizations.map((organization) => organization.name))].sort();
}
