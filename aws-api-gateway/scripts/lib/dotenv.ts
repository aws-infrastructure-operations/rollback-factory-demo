import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Sets KEY=value in a .env file, keeping every other line as-is. */
export function upsertDotenv(file: string, key: string, value: string) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const entry = `${key}=${value}`;
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (index >= 0) lines[index] = entry;
  else lines.push(entry);
  writeFileSync(file, `${lines.join('\n')}\n`);
}
