import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pageResources, StatusCounter } from '../scripts/lib/traffic.js';

test('finds what a built page loads', () => {
  // the shape of a Vite build of app/index.html
  const html = `<!doctype html><html lang="en"><head>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <script type="module" crossorigin src="/assets/index-DZp8_Ewq.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/page-1-y8ncXV.js">
    <link rel="stylesheet" crossorigin href="/assets/page-BwW5LA7K.css">
  </head><body><a href="/">home</a><a href="https://example.com/x.js">x</a>
    <script src="/assets/index-DZp8_Ewq.js"></script></body></html>`;
  assert.deepEqual(pageResources(html), [
    '/favicon.svg', '/assets/index-DZp8_Ewq.js', '/assets/page-1-y8ncXV.js', '/assets/page-BwW5LA7K.css',
  ]);
  assert.deepEqual(pageResources(''), []);
});

test('tallies status codes and the 4xx share', () => {
  const counter = new StatusCounter();
  assert.equal(counter.toString(), '(none)');
  assert.equal(counter.rate4xx, 0);
  for (const status of [200, 403, 403, 0, 200, 404, 500, 200]) counter.add(status);
  assert.equal(counter.total, 8);
  assert.equal(counter.rate4xx, 3 / 8);
  assert.equal(counter.toString(), 'network-errorx1 200x3 403x2 404x1 500x1');
  counter.clear();
  assert.equal(counter.total, 0);
});
