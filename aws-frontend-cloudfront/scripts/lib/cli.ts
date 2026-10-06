import { parseArgs } from 'node:util';
import { EnvConfig, getConfig } from '../../lib/config.js';

type Option = { type: 'string' } | { type: 'boolean'; default: false };

/** Parses `--env <dev|prod>` (default: FRONTEND_ENV or dev) plus extra string / boolean options. */
export function parseCli<S extends string = never, B extends string = never>(
  strings: readonly S[] = [],
  booleans: readonly B[] = [],
) {
  const options: Record<string, Option> = { env: { type: 'string' } };
  for (const name of strings) options[name] = { type: 'string' };
  for (const name of booleans) options[name] = { type: 'boolean', default: false };
  const values = parseArgs({ options, strict: true }).values as
    Partial<Record<'env' | S, string>> & Record<B, boolean>;
  const config: EnvConfig = getConfig(values.env ?? process.env.FRONTEND_ENV ?? 'dev');
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
