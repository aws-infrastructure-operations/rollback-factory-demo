import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

// `npm run -s <missing script>` fails silently, so a workflow step can die with no output.
// Check every script the frontend workflows run exists, and points at a file that exists.

const root = path.resolve(__dirname, '..');
const workflows = path.resolve(root, '..', '.github', 'workflows');
const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

test('every npm script the frontend workflows run is defined', () => {
  const files = ['frontend.yml', 'frontend-deploy.yml', 'frontend-restore.yml', 'break-frontend-demo.yml'];
  const used = new Set(files.flatMap((file) => [
    ...readFileSync(path.join(workflows, file), 'utf8').matchAll(/npm run (?:-s )?([\w:-]+)/g),
  ].map((m) => m[1])));
  assert.ok(used.size > 10, `found only ${[...used].join(', ')}`);
  const missing = [...used].filter((name) => !scripts[name]);
  assert.deepEqual(missing, [], `missing in package.json: ${missing.join(', ')}`);
});

test('every tsx script points at an existing file', () => {
  const broken = Object.entries(scripts)
    .flatMap(([name, command]) => [...command.matchAll(/tsx (scripts\/[\w/-]+\.ts)/g)].map((m) => [name, m[1]]))
    .filter(([, file]) => !existsSync(path.join(root, file)));
  assert.deepEqual(broken, []);
});
