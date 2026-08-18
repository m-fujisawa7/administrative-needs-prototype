import { buildPublicSite, DEFAULT_PUBLIC_SITE_OUTPUT_DIRECTORY } from '../public-site/build.ts';

try {
  const result = await buildPublicSite();
  console.log('Public source list built.');
  console.log(`Organizations: ${result.organizationCount}`);
  console.log(`Sources: ${result.sourceCount}`);
  console.log(`Active sources: ${result.activeSourceCount}`);
  console.log(`Output: ${DEFAULT_PUBLIC_SITE_OUTPUT_DIRECTORY}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
