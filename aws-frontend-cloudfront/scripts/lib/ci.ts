import { execSync } from 'node:child_process';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const gitSha = () => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
};

/**
 * Who / what made a change. Inside GitHub Actions: source "cicd", the GitHub actor, commit and
 * run link. Otherwise "manual" with the caller's AWS identity as actor.
 */
export async function changeContext() {
  const { GITHUB_ACTIONS, GITHUB_ACTOR, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const ci = GITHUB_ACTIONS === 'true';
  return {
    source: ci ? ('cicd' as const) : ('manual' as const),
    actor: ci
      ? `github:${GITHUB_ACTOR}`
      : ((await new STSClient({}).send(new GetCallerIdentityCommand({}))).Arn ?? 'unknown'),
    commit: GITHUB_SHA ?? gitSha(),
    runUrl: ci ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined,
  };
}
