import { pathToFileURL } from 'node:url';
import { loadSourceRegistry } from './load.ts';
import { PRIORITIES, type Priority, type SourceRegistry } from './schema.ts';

export type SourceListFilters = {
  enabledOnly: boolean;
  organizationId?: string;
  priority?: Priority;
};

export function parseSourceListArgs(argv: string[]): SourceListFilters {
  const filters: SourceListFilters = { enabledOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--enabled') {
      filters.enabledOnly = true;
      continue;
    }
    if (argument === '--organization') {
      filters.organizationId = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument?.startsWith('--organization=')) {
      filters.organizationId = argument.slice('--organization='.length);
      continue;
    }
    if (argument === '--priority') {
      filters.priority = parsePriority(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--priority=')) {
      filters.priority = parsePriority(argument.slice('--priority='.length));
      continue;
    }
    throw new Error(`不明なオプションです: ${argument}`);
  }
  return filters;
}

export function formatSourceList(
  registry: SourceRegistry,
  filters: SourceListFilters,
): string {
  const organizations = registry.organizations.filter((organization) =>
    filters.organizationId === undefined || organization.id === filters.organizationId,
  );
  const lines: string[] = [];

  for (const organization of organizations) {
    const sources = registry.sources.filter((source) =>
      source.organization_id === organization.id
      && (!filters.enabledOnly || source.enabled)
      && (filters.priority === undefined || source.priority === filters.priority),
    );
    if (sources.length === 0) continue;

    lines.push(`${organization.name} (${organization.id})`);
    for (const source of sources) {
      const status = source.enabled ? '有効' : '無効';
      lines.push(`  [${source.priority}] [${source.collector_type}] [${status}] ${source.name}`);
      lines.push(`  ${source.url}`);
    }
    lines.push('');
  }

  return lines.length === 0 ? '条件に一致する情報源はありません。' : lines.join('\n').trimEnd();
}

export async function runSourceList(argv = process.argv.slice(2)): Promise<void> {
  const registry = await loadSourceRegistry();
  console.log(formatSourceList(registry, parseSourceListArgs(argv)));
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} の値を指定してください。`);
  }
  return value;
}

function parsePriority(value: string): Priority {
  if (!PRIORITIES.includes(value as Priority)) {
    throw new Error(`priority は ${PRIORITIES.join(', ')} のいずれかを指定してください。`);
  }
  return value as Priority;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSourceList().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
