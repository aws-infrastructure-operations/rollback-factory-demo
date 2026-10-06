# FE-01: CDK project scaffold, config and naming

**Story requirements:** 1 (CDK + TypeScript), 2 (name `frontend-user-<env>`)
**Depends on:** –
**Branch:** `feature/frontend-scaffold`

## Goal

An empty but deployable CDK app in `deploy-aws-cloudfront/`, laid out like `deploy-aws-api-gateway/`,
with the naming and environment config every later ticket uses.

## Scope

- `package.json`, `tsconfig.json`, `cdk.json`, `bin/app.ts`. Use the same tool versions as the API
  (`aws-cdk-lib`, `aws-cdk`, `tsx`, `typescript`, Node 24, `tsx --test` for unit tests).
- `lib/config.ts` with `getConfig(env, overrides)`:
  - `envName`: `dev` | `prod`, from `-c env=` or `FRONTEND_ENV`
  - `frontendName`: `frontend-user-<env>`
  - `resourceName(resource)`: `rollback-factory-demo-<resource>-<env>`
  - `stackName`: `rollback-factory-demo-frontend-<env>`
  - `alarmsStackName`: `rollback-factory-demo-frontend-alarms-<env>`
  - `apiStackName`: `rollback-factory-demo-<env>` (where the API outputs are read from)
  - `retainData`: `true` for prod
  - Placeholders for the alarm settings, `rollbackWindowMinutes` (default 30) and `liveReleaseId`.
    They are filled in by later tickets.
- `bin/app.ts` creates the two stacks:
  - main stack in `CDK_DEFAULT_REGION`
  - alarms stack in `us-east-1`, with `crossRegionReferences: true`
  - Both start empty. Tag the app with `project` and `environment`, like the API.
- Unit test for `getConfig`: names, unknown env rejected, overrides parsed.
- `npm run build` (typecheck), `npm test`, `synth:dev`, `synth:prod`.
- Add `deploy-aws-cloudfront/cdk.out` and `node_modules` to the right `.gitignore`.

## Acceptance criteria

- `npm ci && npm run build && npm test` pass.
- `npx cdk synth -c env=dev` and `-c env=prod` each produce two templates, and the alarms stack's
  region is `us-east-1`.
- Names match the conventions in [README.md](README.md).

## Notes

- Bootstrapping: the alarms stack needs `cdk bootstrap aws://<account>/us-east-1` as well as the main
  region. Note this in the README and handle it in CI (FE-09).
