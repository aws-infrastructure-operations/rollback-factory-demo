# FE-05: DynamoDB deployments table + record / list / verify

**Story requirement:** 8 (record each deployment, manual or CI/CD)
**Depends on:** FE-04
**Branch:** `feature/frontend-deployments-table`

## Goal

Every activation of a release, by hand, by CI or by the rollback Lambda, is recorded in DynamoDB.
The record model matches the API's, so both projects read the same way.

## Scope

- **Table** `rollback-factory-demo-frontend-deployments-<env>` in the main stack:
  - PK `frontendName`, SK `deployedAt` (ISO), on-demand billing, PITR on for prod, retained in prod
  - output `DeploymentsTableName`
- **Record fields:**
  - `releaseId`, `originPath`, `manifestKey`, `distributionId`, `invalidationId`
  - `source`: `manual` | `cicd` | `rollback`
  - `actor`, `commit`, `runUrl`
  - `rolledBackFrom` (rollback records only)
  - `current`, `stable`, `stableFor`, `stableForHumanReadable`, `verifiedAt`, `rolledBackAt`
- **Scripts:**
  - `npm run deployment:record -- --env <env> --release <id>`:
    - writes the record with `current=true`
    - sets `current=false` on the previous record, plus `stable=true` and `stableFor` /
      `stableForHumanReadable`
    - `source` is `cicd` when `GITHUB_ACTIONS` is set, otherwise `manual`
  - `npm run deployment:verify -- --env <env> --release <id>` sets `verifiedAt` after the integration tests pass.
  - `npm run deployment:list -- --env <env>` prints a table of the history.
  - `npm run deployment:restore -- --env <env> --release <id>` activates any recorded release and
    records it with `source=manual`, for a manual restore workflow.
- Share the "stable for" formatting with the API if practical. Otherwise copy it with a note.
- **Unit tests:** record transitions (current → stable), human-readable durations, source detection.

## Acceptance criteria

- `deploy:dev` twice → two records, the older one `stable=true` with `stableFor` set.
- `deployment:list` shows both. `deployment:verify` sets `verifiedAt` on the right one.

## Notes

- Limitation, as for the API: changing the origin path in the console is not recorded.
