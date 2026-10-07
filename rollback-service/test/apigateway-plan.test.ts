// API Gateway manager: deciding what to roll back to, and whether the backend Lambda is at fault.
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { SNSEvent } from 'aws-lambda';
import type { DeploymentRecord } from '../lambda/managers/apigateway/deployments.js';
import {
  AlarmPair, frozenLambdas, isRestoreRequest, lambdaArnsFromSpec, lambdaFault, parseAlarms, planRollback, pointToAlias,
} from '../lambda/managers/apigateway/plan.js';

describe('planRollback', () => {
  const now = new Date('2026-10-06T12:30:00.000Z');
  const rec = (deployedAt: string, deploymentId: string, extra: Partial<DeploymentRecord> = {}) =>
    ({ apiName: 'api-user-dev', deployedAt, deploymentId, source: 'cicd', ...extra }) as DeploymentRecord;

  const good = rec('2026-10-06T11:00:00.000Z', 'good', { verifiedAt: '2026-10-06T11:02:00.000Z' });
  const bad = rec('2026-10-06T12:20:00.000Z', 'bad');

  test('rolls the recent deployment back to the previous verified one', () => {
    assert.deepEqual(planRollback([bad, good], now, 30), { action: 'rollback', from: bad, to: good });
  });

  test('skips deployments older than the window', () => {
    const plan = planRollback([bad, good], now, 5);
    assert.equal(plan.action, 'skip');
    assert.match((plan as any).reason, /10 min old \(window: 5 min\)/);
  });

  test('never rolls back a rollback or an already rolled back deployment', () => {
    const rollback = rec('2026-10-06T12:25:00.000Z', 'r1', { source: 'rollback' });
    assert.equal(planRollback([rollback, bad, good], now, 30).action, 'skip');
    const restore = rec('2026-10-06T12:25:00.000Z', 'r2', { source: 'restore' });
    assert.equal(planRollback([restore, bad, good], now, 30).action, 'skip');
    assert.equal(planRollback([{ ...bad, rolledBackAt: now.toISOString() }, good], now, 30).action, 'skip');
  });

  test('skips the same deployment id recorded twice and needs a target', () => {
    const dupe = rec('2026-10-06T12:10:00.000Z', 'bad');
    assert.deepEqual(planRollback([bad, dupe, good], now, 30), { action: 'rollback', from: bad, to: good });
    assert.equal(planRollback([bad], now, 30).action, 'skip');
    assert.equal(planRollback([], now, 30).action, 'skip');
  });

  // What broke dev on 2026-10-06: a broken demo deploy was never rolled back (the alarm
  // couldn't publish), so the next failed deploy was "rolled back" onto it.
  test('never restores an unverified deployment, even if it is the previous one', () => {
    const untestedBroken = rec('2026-10-06T12:00:00.000Z', 'broken');
    const plan = planRollback([bad, untestedBroken, good], now, 30);
    assert.deepEqual(plan, { action: 'rollback', from: bad, to: good });
    assert.deepEqual(planRollback([bad, untestedBroken], now, 30), {
      action: 'skip', reason: 'no earlier verified deployment to roll back to',
    });
  });

  test('never restores a verified deployment that was rolled back later', () => {
    const verifiedButRolledBack = rec('2026-10-06T12:00:00.000Z', 'flaky', {
      verifiedAt: '2026-10-06T12:01:00.000Z', rolledBackAt: '2026-10-06T12:10:00.000Z',
    });
    assert.deepEqual(planRollback([bad, verifiedButRolledBack, good], now, 30), { action: 'rollback', from: bad, to: good });
  });
});

test('recognises manual restore requests', () => {
  assert.ok(isRestoreRequest({ restore: { deployedAt: '2026-10-06T11:38:01.784Z' } }));
  assert.ok(!isRestoreRequest({ Records: [] }));
  assert.ok(!isRestoreRequest({ restore: {} }));
});

test('parses CloudWatch alarm notifications from SNS', () => {
  const event = {
    Records: [{ Sns: { Message: JSON.stringify({
      AlarmName: 'rollback-factory-demo-apigateway-api-user-5xx-rate-dev', NewStateValue: 'ALARM', NewStateReason: 'Threshold Crossed',
    }) } }],
  } as unknown as SNSEvent;
  assert.deepEqual(parseAlarms(event), [
    { alarmName: 'rollback-factory-demo-apigateway-api-user-5xx-rate-dev', newState: 'ALARM', reason: 'Threshold Crossed' },
  ]);
});

test('finds the versioned Lambda ARNs in an exported spec', () => {
  const fn = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev:7';
  const integration = {
    type: 'aws_proxy',
    uri: `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${fn}/invocations`,
  };
  const spec = {
    paths: {
      '/users': { get: { 'x-amazon-apigateway-integration': integration }, post: { 'x-amazon-apigateway-integration': integration } },
      '/health': { get: { 'x-amazon-apigateway-integration': { type: 'mock' } } },
    },
  };
  assert.deepEqual(lambdaArnsFromSpec(spec), [fn]);
});

describe('lambdaFault', () => {
  const pair: AlarmPair = {
    apiAlarm: 'rollback-factory-demo-apigateway-api-user-5xx-rate-dev',
    lambdaAlarm: 'rollback-factory-demo-apigateway-api-user-handler-5xx-rate-dev',
    apiMetric: '5XXError',
    lambdaMetric: 'Lambda5XXError',
  };

  test('blames the Lambda while its paired alarm is in ALARM', () => {
    assert.match(lambdaFault(pair, { lambdaAlarmState: 'ALARM', apiErrors: 10, lambdaErrors: 0 })!, /handler-5xx-rate-dev is in ALARM/);
  });

  test('blames the Lambda when it produced at least half of the errors, even before its alarm fires', () => {
    assert.match(lambdaFault(pair, { lambdaAlarmState: 'OK', apiErrors: 10, lambdaErrors: 5 })!, /5 of the 10 5XXError/);
  });

  test('lets the API roll back when API Gateway produced most errors', () => {
    assert.equal(lambdaFault(pair, { lambdaAlarmState: 'OK', apiErrors: 10, lambdaErrors: 4 }), undefined);
    assert.equal(lambdaFault(pair, { lambdaAlarmState: 'INSUFFICIENT_DATA', apiErrors: 0, lambdaErrors: 0 }), undefined);
  });
});

test('points restored specs at the live alias, whatever version they were recorded with', () => {
  const fn = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev';
  const other = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev-other:3';
  const uri = (arn: string) => `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${arn}/invocations`;
  const op = (arn: string) => ({ 'x-amazon-apigateway-integration': { type: 'aws_proxy', uri: uri(arn) } });
  const spec = {
    paths: {
      '/users': { get: op(`${fn}:7`), post: op(`${fn}:live`) },
      '/messages': { get: op(fn), post: op(other) },
      '/health': { get: { 'x-amazon-apigateway-integration': { type: 'mock' } } },
    },
  };
  const result = pointToAlias(spec, fn, `${fn}:live`);
  assert.deepEqual(lambdaArnsFromSpec(result).sort(), [`${fn}:live`, other].sort());
  assert.equal(result.paths['/users'].get['x-amazon-apigateway-integration'].uri, uri(`${fn}:live`));
  // the input is not modified
  assert.equal(spec.paths['/users'].get['x-amazon-apigateway-integration'].uri, uri(`${fn}:7`));
});

test('a restored spec keeps each resource on its own backend\'s stage alias', () => {
  const arn = (backend: string) => `arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-api-${backend}-dev`;
  const uri = (target: string) => `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${target}/invocations`;
  const op = (target: string) => ({ 'x-amazon-apigateway-integration': { type: 'aws_proxy', uri: uri(target) } });
  // recorded with pinned versions; the stage variable keeps v1 on live, integration on integration
  let spec: any = { paths: { '/users': { get: op(`${arn('users')}:4`) }, '/messages': { post: op(`${arn('messages')}:9`) } } };
  for (const backend of ['users', 'messages']) spec = pointToAlias(spec, arn(backend), `${arn(backend)}:\${stageVariables.lambdaAlias}`);
  assert.equal(spec.paths['/users'].get['x-amazon-apigateway-integration'].uri, uri(`${arn('users')}:\${stageVariables.lambdaAlias}`));
  assert.equal(spec.paths['/messages'].post['x-amazon-apigateway-integration'].uri, uri(`${arn('messages')}:\${stageVariables.lambdaAlias}`));
});

test('after the rewrite, only integrations outside the backends stay frozen: a restore refuses them', () => {
  const arn = (backend: string) => `arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-api-${backend}-dev`;
  const uri = (target: string) => `arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/${target}/invocations`;
  const op = (target: string) => ({ 'x-amazon-apigateway-integration': { type: 'aws_proxy', uri: uri(target) } });
  const preSplit = 'arn:aws:lambda:eu-west-1:123456789012:function:rollback-factory-demo-handler-dev:5';
  // a pinned version, a bare function and the stage alias: all go to the stage alias
  let spec: any = {
    paths: {
      '/users': { get: op(`${arn('users')}:5`), post: op(arn('users')) },
      '/orders': { get: op(`${arn('orders')}:\${stageVariables.lambdaAlias}`) },
    },
  };
  for (const backend of ['users', 'orders']) spec = pointToAlias(spec, arn(backend), `${arn(backend)}:\${stageVariables.lambdaAlias}`);
  assert.deepEqual(frozenLambdas(spec), []);
  // a route still on the pre-split handler would run its old code
  spec.paths['/messages'] = { get: op(preSplit) };
  assert.deepEqual(frozenLambdas(spec), [preSplit]);
});
