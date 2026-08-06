import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function writeJsonFile(outputPath: string, value: unknown): Promise<string> {
  const absolutePath = resolve(outputPath);
  const outputDirectory = dirname(absolutePath);
  const temporaryPath = join(
    outputDirectory,
    `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(outputDirectory, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return absolutePath;
}
