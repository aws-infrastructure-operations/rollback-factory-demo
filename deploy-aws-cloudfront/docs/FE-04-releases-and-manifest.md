# FE-04: Versioned releases, build manifest, activation

**Story requirements:** 6 (each build in `releases/<id>/`, origin path switch), 7 (build manifest in S3)
**Depends on:** FE-02, FE-03
**Branch:** `feature/frontend-releases`

## Goal

Scripts that turn a commit into an immutable release, store its manifest, and make it the live
release by switching the distribution's origin path and invalidating the cache.

## Scope

- **Deployments bucket** in the main stack:
  `rollback-factory-demo-<account>-frontend-deployments-<env>`, versioned, private, `enforceSSL`.
  Output `DeploymentsBucketName`.
- `scripts/lib/stack-outputs.ts` reads outputs of the API stack (`ApiUrl`, `UserPoolId`,
  `UserPoolClientId`) and of the frontend stack.
- `npm run release:build -- --env <env>`:
  1. release id = UTC `yyyymmddThhmmssZ`
  2. reads the API outputs and builds the app with them (`VITE_*`, `VITE_RELEASE_ID`)
  3. writes `dist/` and `release.json` (id, env)
- `npm run release:upload -- --env <env>`:
  - uploads `dist/` to `s3://<site bucket>/releases/<id>/` with the right `Content-Type`
  - `Cache-Control`: `no-cache` for `*.html`, `public, max-age=31536000, immutable` for `assets/*`
  - writes the **manifest** to `s3://<deployments bucket>/frontend-user-<env>/<id>/manifest.json`:
    `{ releaseId, frontendName, env, commit, actor, runUrl, builtAt, apiUrl, userPoolId,
    files: [{ path, size, sha256, contentType }] }`
  - Releases are never overwritten. The script fails if `releases/<id>/` already exists.
- `npm run release:activate -- --env <env> --release <id>`:
  - checks every manifest file is in the site bucket
  - `GetDistributionConfig` → set origin path `/releases/<id>` → `UpdateDistribution` with the ETag
  - `CreateInvalidation` for `/*`
  - optional `--wait` waits until the distribution is `Deployed` and the invalidation `Completed`,
    and prints both durations (the story asks to measure rollback speed)
- `npm run live:context -- --env <env>` prints `-c liveReleaseId=<id>` from the distribution's
  current origin path, so `cdk deploy` keeps the live release (see FE-02).
- `npm run deploy:<env>` chains: live context → cdk deploy → build → upload → activate → record (FE-05).
- Shared code for the origin-path switch (`lib/release-switch.ts`) is reused by the rollback Lambda (FE-08).
- **Unit tests:** manifest building (hashes, content types), release id format, origin-path parsing.

## Acceptance criteria

- Two builds in a row create two prefixes and two manifests. Activating the first after the second
  serves the first release (visible in the footer) once the invalidation completes.
- The manifest's hashes match the uploaded objects.
- `cdk deploy` with `live:context` output leaves the origin path unchanged.

## Notes

- **Deviation:** the story's bucket name (`frontendname-awsaccount-deployments-datetimestamp`)
  suggests one bucket per deployment. Like the API, use one bucket per environment with the timestamp
  in the key.
- The manifest is written before activation, so every release, even one never activated, has a
  manifest.
