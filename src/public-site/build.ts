import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceRegistry } from '../source-registry/load.ts';
import { renderPublicSourcePage } from './render.ts';
import { createPublicSourceList } from './source-list.ts';

export const DEFAULT_PUBLIC_SITE_OUTPUT_DIRECTORY = fileURLToPath(
  new URL('../../dist/public-site', import.meta.url),
);

const DEFAULT_STYLESHEET_PATH = fileURLToPath(
  new URL('../../site/styles.css', import.meta.url),
);

const DEFAULT_SEARCH_SCRIPT_PATH = fileURLToPath(
  new URL('./search.js', import.meta.url),
);

export async function buildPublicSite(
  outputDirectory = DEFAULT_PUBLIC_SITE_OUTPUT_DIRECTORY,
): Promise<{ activeSourceCount: number; organizationCount: number; sourceCount: number }> {
  const registry = await loadSourceRegistry();
  const sourceList = createPublicSourceList(registry);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, 'index.html'), renderPublicSourcePage(sourceList), 'utf8'),
    copyFile(DEFAULT_STYLESHEET_PATH, join(outputDirectory, 'styles.css')),
    copyFile(DEFAULT_SEARCH_SCRIPT_PATH, join(outputDirectory, 'search.js')),
  ]);

  return {
    activeSourceCount: sourceList.activeSourceCount,
    organizationCount: sourceList.organizationCount,
    sourceCount: sourceList.sourceCount,
  };
}
