import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  validateSourceRegistry,
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
