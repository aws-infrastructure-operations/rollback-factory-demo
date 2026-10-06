export type EnvName = 'dev' | 'prod';

export interface EnvConfig {
  envName: EnvName;
  apiName: string;
  stackName: string;
  stageName: string;
  /** Whether stateful resources (user pool) survive stack deletion. */
  retainData: boolean;
}

export const STAGE_NAME = 'v1';

export function getConfig(envName: string | undefined): EnvConfig {
  if (envName !== 'dev' && envName !== 'prod') {
    throw new Error(`Unknown env "${envName}". Pass -c env=dev or -c env=prod`);
  }
  return {
    envName,
    apiName: `api-user-${envName}`,
    stackName: `ApiUserStack-${envName}`,
    stageName: STAGE_NAME,
    retainData: envName === 'prod',
  };
}
