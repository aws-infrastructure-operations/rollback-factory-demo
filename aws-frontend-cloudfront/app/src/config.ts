// Build-time settings. The release build (FE-04) sets them from the api-user stack outputs;
// a local `npm run app:dev` reads them from app/.env.local (see app/.env.example).

export interface AppConfig {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
  releaseId: string;
}

const env = import.meta.env as Record<string, string | undefined>;

export function loadConfig(): AppConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set. Copy app/.env.example to app/.env.local for local runs.`);
    return value;
  };
  return {
    apiUrl: required('VITE_API_URL'),
    userPoolId: required('VITE_USER_POOL_ID'),
    userPoolClientId: required('VITE_USER_POOL_CLIENT_ID'),
    region: required('VITE_REGION'),
    releaseId: env.VITE_RELEASE_ID || 'local',
  };
}
