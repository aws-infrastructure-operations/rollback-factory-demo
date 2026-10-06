# FE-11: Integration distribution: test each release before clients get it

**Story requirements:** 9 (integration steps), 12 (deploy, test, promote)
**Depends on:** FE-09
**Branch:** `feature/frontend-integration-distribution`

## Goal

Test every release on its own CloudFront distribution before `frontend-user-<env>` serves it, the
same way the API tests on its `integration` stage before promoting to `v1`. A failing release must
never reach clients. This replaces FE-09's approach of making the release live, testing it, and
switching back if the tests fail.

## Scope

- **Second distribution** `frontend-user-<env>-integration` in the main stack:
  - configured the same way as `frontend-user-<env>`
  - reads the same site bucket, through its own Origin Access Control
  - no alarms and not touched by the rollback Lambda, so test traffic never counts toward a rollback
  - the existing distribution keeps its construct id, so it is updated in place, not replaced
  - outputs `IntegrationDistributionId` and `IntegrationSiteUrl`
- **Origin paths:** `-c integrationReleaseId` keeps the integration distribution's origin path on
  deploy. `live:context` prints both context values.
- **Activation:** `release:activate --target integration` switches the integration distribution.
  `live`, the default, switches `frontend-user-<env>`.
- **Tests:** `FRONTEND_TARGET=integration` runs the integration tests against the integration distribution.
- **`frontend-deploy.yml`:**
  1. cdk deploy, build and upload, as before
  2. activate the release on the integration distribution and run the tests there
  3. only then, activate it on `frontend-user-<env>`, record and verify
  - The step that switched back after failed tests is gone.
- **Unchanged:**
  - **Records and verification:** only `frontend-user-<env>` is recorded and verified.
  - **Rollback:** the rollback Lambda and the alarms only watch `frontend-user-<env>`.
  - **Restore, demo and manual deploy:** `frontend-restore`, `break-frontend-demo` and `deploy:<env>`
    act on `frontend-user-<env>` directly.

## Acceptance criteria

- Synth shows two distributions with their own origin paths. The bucket policy lets exactly those
  two read it.
- A release that fails the integration tests leaves `frontend-user-<env>` on its previous release,
  and the deployment table has no new record.
- A release that passes is served by both distributions and recorded as verified.
