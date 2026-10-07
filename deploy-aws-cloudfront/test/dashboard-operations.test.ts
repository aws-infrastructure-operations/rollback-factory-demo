import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { getOperation, parseOperationId } from '../lambda/dashboard-api/operations.js';
import { handler } from '../lambda/dashboard-api/handler.js';

const PROJECT = 'rollback-factory-demo';
const STARTED = Date.parse('2026-10-07T10:00:00.000Z');
const ID = `dev.cloudfront-restore.${STARTED}.a1b2c3d4`;
const REQ = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

/** Node runtime lines: "<time>\t<request id>\t<LEVEL>\t<message>", and START/END/REPORT. */
const runtime = (seconds: number, level: string, message: string) => ({
  timestamp: STARTED + seconds * 1000, message: `2026-10-07T10:00:0${seconds}.000Z\t${REQ}\t${level}\t${message}\n`,
});
const system = (seconds: number, message: string) => ({ timestamp: STARTED + seconds * 1000, message: `${message}\n` });

const RUN = [
  system(1, `START RequestId: ${REQ} Version: $LATEST`),
  runtime(1, 'INFO', `Event: {"type":"restore","manager":"cloudfront","deployedAt":"2026-10-06T19:05:00.000Z","operationId":"${ID}"}`),
  runtime(2, 'INFO', '{"manager":"cloudfront","msg":"restoring","to":"20261006T190000Z"}'),
  runtime(4, 'INFO', '{"manager":"cloudfront","msg":"release switched","step":"release-switched","to":"20261006T190000Z"}'),
  runtime(5, 'INFO', '{"manager":"cloudfront","msg":"restore complete","invalidationId":"INV"}'),
  runtime(5, 'INFO', '{"msg":"result","result":{"action":"restored","from":"20261007T101500Z","to":"20261006T190000Z"}}'),
  system(5, `END RequestId: ${REQ}`),
  system(5, `REPORT RequestId: ${REQ}\tDuration: 4012.00 ms\tBilled Duration: 4013 ms`),
];

/** A log group holding `events`; answers FilterLogEvents like CloudWatch (quoted term = substring). */
const fakeLogs = (events: Array<{ timestamp: number; message: string }>) => {
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      assert.ok(command instanceof FilterLogEventsCommand);
      sent.push(command.input);
      const term = command.input.filterPattern!.replace(/^"|"$/g, '');
      return { events: events.filter((e) => e.message.includes(term) && e.timestamp >= command.input.startTime!) };
    },
  } as unknown as CloudWatchLogsClient;
  return { client, sent };
};

test('operation ids carry the environment, the kind and the start', () => {
  assert.deepEqual(parseOperationId(ID), { env: 'dev', kind: 'cloudfront-restore', startedAt: STARTED });
  for (const bad of ['dev.restore.1.a1b2c3d4', `dev.cloudfront-restore.${STARTED}`, '../../etc', `Dev.cloudfront-restore.${STARTED}.a1b2c3d4`]) {
    assert.equal(parseOperationId(bad), undefined, bad);
  }
});

test('a finished restore: every line of the run, all steps done, succeeded', async () => {
  const logs = fakeLogs(RUN);
  const view = await getOperation(logs.client, PROJECT, ID, STARTED + 10_000);
  assert.equal(view!.status, 'succeeded');
  assert.equal(view!.progress, 100);
  assert.ok(view!.steps.every((s) => s.done));
  assert.equal(view!.lines.length, RUN.length);
  assert.deepEqual(view!.lines[2], { time: '2026-10-07T10:00:02.000Z', level: 'INFO', text: '{"manager":"cloudfront","msg":"restoring","to":"20261006T190000Z"}' });
  assert.equal(view!.lines[0].level, 'RUNTIME');
  assert.deepEqual(view!.result, { action: 'restored', from: '20261007T101500Z', to: '20261006T190000Z' });
  // the run is found by the operation id, then all its lines by the request id, in the right log group
  assert.deepEqual(logs.sent.map((s) => [s.logGroupName, s.filterPattern]), [
    ['rollback-factory-demo-rollback-service-logs-dev', `"${ID}"`],
    ['rollback-factory-demo-rollback-service-logs-dev', `"${REQ}"`],
  ]);
});

test('a running restore: the steps done so far set the progress', async () => {
  const view = await getOperation(fakeLogs(RUN.slice(0, 3)).client, PROJECT, ID, STARTED + 3000);
  assert.equal(view!.status, 'running');
  assert.deepEqual(view!.steps.map((s) => s.done), [true, true, false, false]);
  assert.equal(view!.progress, 48);
});

test('queued until the run logs, then lost after a few minutes', async () => {
  const queued = await getOperation(fakeLogs([]).client, PROJECT, ID, STARTED + 2000);
  assert.equal(queued!.status, 'queued');
  assert.ok(queued!.progress > 0 && queued!.progress < 10);
  const lost = await getOperation(fakeLogs([]).client, PROJECT, ID, STARTED + 6 * 60_000);
  assert.equal(lost!.status, 'failed');
  assert.match(lost!.reason!, /never logged/);
});

test('a skipped restore says why; a failed one too', async () => {
  const skipped = [...RUN.slice(0, 2),
    runtime(2, 'INFO', '{"msg":"result","result":{"action":"skip","reason":"frontend-user-dev already serves release 20261006T190000Z"}}'),
    system(2, `REPORT RequestId: ${REQ}\tDuration: 900.00 ms`)];
  const s = await getOperation(fakeLogs(skipped).client, PROJECT, ID, STARTED + 5000);
  assert.equal(s!.status, 'skipped');
  assert.equal(s!.reason, 'frontend-user-dev already serves release 20261006T190000Z');

  const failed = [...RUN.slice(0, 3),
    runtime(3, 'ERROR', '{"msg":"failed","error":"AccessDenied: cloudfront:UpdateDistribution"}'),
    runtime(3, 'ERROR', 'Invoke Error \t{"errorType":"AccessDenied"}'),
    system(3, `REPORT RequestId: ${REQ}\tDuration: 2100.00 ms`)];
  const f = await getOperation(fakeLogs(failed).client, PROJECT, ID, STARTED + 5000);
  assert.equal(f!.status, 'failed');
  assert.equal(f!.reason, 'AccessDenied: cloudfront:UpdateDistribution');
  assert.equal(f!.progress, 100);
});

test('GET /api/operations/<id>: 404 for an id that is not one, 405 for other methods', async () => {
  const call = (path: string, method = 'GET') => handler({ rawPath: path, requestContext: { http: { method } } });
  assert.equal((await call('/api/operations/not-an-operation')).statusCode, 404);
  assert.equal((await call(`/api/operations/${ID}`, 'POST')).statusCode, 405);
});
