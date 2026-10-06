# FE-09: GitHub workflow: deploy, test, promote to prod

**Story requirement:** 12 (deploy + record + manifest, integration tests, prod when green, rollback on alarms)
**Depends on:** FE-05, FE-06 (FE-07/FE-08 should be merged before the first prod run)
**Branch:** `feature/frontend-workflow`

## Goal

CI deploys the frontend to dev, tests it, and deploys to prod only when dev is green, the same way
the API workflows do.

## Scope

- `.github/workflows/frontend.yml` (entry point) and `frontend-deploy.yml` (reusable, per env).
- **Triggers:** PRs and pushes to `main` that touch `deploy-aws-cloudfront/**` or
  `.github/workflows/frontend*.yml`, ignoring `*.md`, plus `workflow_dispatch` (`promote_to_prod`).
- **PR job:** `npm ci`, typecheck, unit tests, app build with dummy config, `cdk synth` dev and prod.
- **Deploy job per environment** (dev, then prod), `environment: <env>`,
  `concurrency: frontend-deploy-<env>`:
  1. bootstrap the main region and `us-east-1`
  2. `live:context` → `cdk deploy --all -c env=<env> -c liveReleaseId=...` (infra only; the live
     release is untouched)
  3. `release:build` (API outputs of the same env) → `release:upload` (release + manifest)
  4. remember the previous release id, then `release:activate --wait`
  5. `deployment:record`
  6. `test:integration --release <id>`
     - **on failure:** `release:activate` the previous release, record it (`source=cicd`, rolled
       back from the new one), print the test output in the summary and fail the job
  7. `deployment:verify`
  8. `deployment:list` in the job summary
- **Promotion:** `deploy-prod` needs `deploy-dev`. Prod gets its own build (prod API URL and user
  pool), so "promote" means the same commit, rebuilt with prod config. Required reviewers on the
  `prod` environment give an approval gate.
- **Alarm rollback** stays in AWS (FE-08). The workflow doesn't watch alarms.
- Optional `frontend-restore.yml`: manual `workflow_dispatch(env, release)` → `deployment:restore`.
- Playwright browser cache + `npx playwright install --with-deps chromium`.

## Acceptance criteria

- A PR touching the frontend runs only the PR job.
- A merge to `main` deploys dev, tests it, then deploys prod. Both environments' history is in the summary.
- A release that breaks a smoke test (for example a missing asset) is switched back to the previous
  release in that environment, and prod is not deployed.

## Notes

- **Order with the API:** the frontend build reads the API stack outputs. If the API stack doesn't
  exist yet in an env, fail early with a clear message.
- Why not test before activation: S3 is private and the distribution has one origin path, so a
  release can only be tested through CloudFront once it is live. A second "preview" distribution
  would avoid that, but doubles the slow distribution updates. Test after activating; switch back
  on failure.
