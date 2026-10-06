// Build-time settings. The release build (scripts/build-release.ts) sets them; a local
// `npm run app:dev` reads them from app/.env.local (see app/.env.example) or uses the defaults.

export interface AppConfig {
  env: string;
  releaseId: string;
  /** ISO 8601, or undefined for a local build. */
  builtAt?: string;
}

const env = import.meta.env as Record<string, string | undefined>;

export function loadConfig(): AppConfig {
  return {
    env: env.VITE_ENV || 'local',
    releaseId: env.VITE_RELEASE_ID || 'local',
    builtAt: env.VITE_BUILT_AT || undefined,
  };
}
