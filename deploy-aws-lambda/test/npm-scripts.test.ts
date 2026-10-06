import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { getConfig } from '../lib/config.js';

// `npm run -s <missing script>` fails silently, so a workflow step can die with no output.
// Check every script the lambda workflows run exists, and that the names they hard-code match config.

const root = path.resolve(__dirname, '..');
const workflows = path.resolve(root, '..', '.github', 'workflows');
const files = ['lambda.yml', 'lambda-deploy.yml', 'lambda-rollback-by-version.yml', 'lambda-rollback-to-commit.yml'];
const read = (file: string) => readFileSync(path.join(workflows, file), 'utf8');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

test('every npm script the lambda workflows run is defined', () => {
  const used = new Set(files.flatMap((file) => [...read(file).matchAll(/npm run (?:-s )?([\w:-]+)/g)].map((m) => m[1])));
  assert.ok(used.size >= 5, `found only ${[...used].join(', ')}`);
  const missing = [...used].filter((name) => !scripts[name]);
  assert.deepEqual(missing, [], `missing in package.json: ${missing.join(', ')}`);
});

test('every tsx script points at an existing file', () => {
  const broken = Object.entries(scripts)
    .flatMap(([name, command]) => [...command.matchAll(/tsx (scripts\/[\w/-]+\.ts)/g)].map((m) => [name, m[1]]))
    .filter(([, file]) => !existsSync(path.join(root, file)));
  assert.deepEqual(broken, []);
});

test('the names the workflows build from the environment match the config', () => {
  const config = getConfig('dev');
  const text = files.map(read).join('\n').replaceAll('${{ inputs.environment }}', 'dev');
  for (const name of [config.functionName, config.rollbackFunctionName, config.versionsTableName]) {
    assert.ok(text.includes(name), `${name} not found in the workflows`);
  }
  for (const hardCoded of text.matchAll(/(rollback-factory-demo-lambda-[\w-]+?|service-lambda)-dev\b/g)) {
    assert.ok([config.functionName, config.rollbackFunctionName, config.versionsTableName].includes(hardCoded[0]),
      `unexpected name ${hardCoded[0]}`);
  }
});
