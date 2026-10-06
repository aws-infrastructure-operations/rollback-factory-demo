import { parseArgs } from 'node:util';
import { EnvConfig, getConfig } from '../../lib/config.js';

/** Parses `--env <dev|testing|staging|prod>` (default: API_ENV or dev) plus any extra string options. */
export function parseCli<T extends string>(extra: readonly T[] = []) {
  const options = Object.fromEntries([
    ['env', { type: 'string' }],
    ...extra.map((name) => [name, { type: 'string' }]),
  ]) as Record<'env' | T, { type: 'string' }>;
  const values = parseArgs({ options, strict: true }).values as Partial<Record<'env' | T, string>>;
  const config: EnvConfig = getConfig(values.env ?? process.env.API_ENV ?? 'dev');
  return { config, values };
}

export const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

export async function run(main: () => Promise<void>) {
  try {
    await main();
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
