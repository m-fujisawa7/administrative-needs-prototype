import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';
import { loadSourceRegistry } from './load.ts';

export async function runValidation(): Promise<void> {
  const registry = await loadSourceRegistry();
  const enabledSources = registry.sources.filter((source) => source.enabled).length;

  console.log('情報源台帳は有効です。');
  console.log(`組織: ${registry.organizations.length}`);
  console.log(`情報源: ${registry.sources.length}`);
  console.log(`有効な情報源: ${enabledSources}`);
}

function printError(error: unknown): void {
  console.error('情報源台帳の検証に失敗しました。');
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      console.error(`- ${formatPath(issue.path)}: ${issue.message}`);
    }
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
}

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`;
    return result === '' ? String(part) : `${result}.${String(part)}`;
  }, '');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runValidation().catch((error: unknown) => {
    printError(error);
    process.exitCode = 1;
  });
}
