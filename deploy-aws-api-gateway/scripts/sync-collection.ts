/**
 * Creates / updates the Bruno collection for an environment:
 *   1. synthesizes the CDK stack and generates one request per API method
 *   2. writes bruno/environments/<env>.bru from the deployed stack outputs
 *
 * Usage: npx tsx scripts/sync-collection.ts --env dev
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  extractRoutes, GENERATED_MARKER, parseEnvironment, renderEnvironment, renderRequest, requestFile,
} from './lib/collection.js';
import { log, parseCli, run } from './lib/cli.js';
import { BRUNO_DIR, PROJECT_ROOT } from './lib/paths.js';
import { awsRegion, getStackOutputs } from './lib/stack.js';

run(async () => {
  const { config } = parseCli();

  // 1. Requests from the synthesized template
  const outDir = path.join('cdk.out', config.envName);
  log(`Synthesizing ${config.stackName}...`);
  execSync(`npx cdk synth -c env=${config.envName} -q -o ${outDir}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  const template = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, outDir, `${config.stackName}.template.json`), 'utf8'),
  );

  const written = new Set<string>();
  const seqByFolder = new Map<string, number>();
  for (const route of extractRoutes(template)) {
    const { folder, file } = requestFile(route);
    const seq = (seqByFolder.get(folder) ?? 0) + 1;
    seqByFolder.set(folder, seq);

    mkdirSync(path.join(BRUNO_DIR, folder), { recursive: true });
    const target = path.join(BRUNO_DIR, folder, file);
    writeFileSync(target, renderRequest(route, seq));
    written.add(target);
    log(`  ${route.method.padEnd(6)} ${route.path} -> bruno/${folder}/${file}`);
  }

  // Drop generated requests for routes that no longer exist
  for (const entry of readdirSync(BRUNO_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'environments') continue;
    const dir = path.join(BRUNO_DIR, entry.name);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.bru'))) {
      const full = path.join(dir, file);
      if (!written.has(full) && readFileSync(full, 'utf8').includes(GENERATED_MARKER)) {
        rmSync(full);
        log(`  removed stale bruno/${entry.name}/${file}`);
      }
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }

  // 2. Environment from stack outputs (keeps previous values if not deployed yet)
  const envFile = path.join(BRUNO_DIR, 'environments', `${config.envName}.bru`);
  const previous = existsSync(envFile) ? parseEnvironment(readFileSync(envFile, 'utf8')) : {};
  const [outputs, region] = await Promise.all([
    getStackOutputs(config).catch((err) => log(`  WARN: cannot read stack outputs (${err.message})`)),
    awsRegion().catch(() => undefined),
  ]);
  if (!outputs) log(`  ${config.stackName} outputs unavailable - keeping existing environment values`);

  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, renderEnvironment({
    baseUrl: outputs?.ApiUrl.replace(/\/$/, '') ?? previous.baseUrl ?? 'https://deploy-first.invalid',
    region: region ?? previous.region ?? '',
    userPoolId: outputs?.UserPoolId ?? previous.userPoolId ?? '',
    userPoolClientId: outputs?.UserPoolClientId ?? previous.userPoolClientId ?? '',
    idToken: `{{process.env.ID_TOKEN_${config.envName.toUpperCase()}}}`,
  }));
  log(`Updated bruno/environments/${config.envName}.bru`);
});
