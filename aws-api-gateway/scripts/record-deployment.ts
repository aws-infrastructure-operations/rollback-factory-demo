/**
 * Run after `cdk deploy`: exports the stage's OpenAPI spec to the deployments
 * bucket and records the deployment in DynamoDB. Skips if the stage still
 * points at the last recorded deployment (nothing changed) unless --force.
 *
 * Usage: npx tsx scripts/record-deployment.ts --env dev [--description "..."] [--force]
 *
 * Source is "cicd" inside GitHub Actions (commit, actor and run URL come from the
 * GITHUB_* variables), otherwise "manual" with the caller's AWS identity as actor.
 */
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { getConfig } from '../lib/config.js';
import { recordDeployment } from '../lambda/shared/deployments.js';
import { log, run } from './lib/cli.js';
import { deploymentTarget, requireStackOutputs } from './lib/stack.js';

const gitSha = () => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
};

run(async () => {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      description: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const config = getConfig(values.env ?? process.env.API_ENV ?? 'dev');
  const target = deploymentTarget(config, await requireStackOutputs(config));

  const { GITHUB_ACTIONS, GITHUB_ACTOR, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } =
    process.env;
  const ci = GITHUB_ACTIONS === 'true';
  const actor = ci
    ? `github:${GITHUB_ACTOR}`
    : ((await new STSClient({}).send(new GetCallerIdentityCommand({}))).Arn ?? 'unknown');

  const record = await recordDeployment(target, {
    source: ci ? 'cicd' : 'manual',
    actor,
    commitSha: GITHUB_SHA ?? gitSha(),
    runUrl: ci ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined,
    description: values.description,
    force: values.force,
  });

  if (!record) {
    log(`${config.apiName}/${target.stageName}: deployment unchanged since last record - nothing recorded`);
    return;
  }
  log(`Recorded ${record.source} deployment ${record.deploymentId} of ${config.apiName}/${record.stageName}`);
  log(`  spec:  s3://${record.specBucket}/${record.specKey}`);
  log(`  table: ${target.table} (deployedAt=${record.deployedAt})`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
});
