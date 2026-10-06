import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { cacheControlFor, contentTypeFor, ManifestFile } from '../../lambda/shared/releases.js';

/** Every file of a build directory with its size, sha256 and upload headers, sorted by path. */
export async function describeFiles(dir: string): Promise<ManifestFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = await Promise.all(entries.filter((e) => e.isFile()).map(async (entry) => {
    const fullPath = path.join(entry.parentPath, entry.name);
    const filePath = path.relative(dir, fullPath).split(path.sep).join('/');
    const body = await readFile(fullPath);
    return {
      path: filePath,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      contentType: contentTypeFor(filePath),
      cacheControl: cacheControlFor(filePath),
    };
  }));
  if (!files.length) throw new Error(`${dir} is empty - run npm run release:build first`);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
