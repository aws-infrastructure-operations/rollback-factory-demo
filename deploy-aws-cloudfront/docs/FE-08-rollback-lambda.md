# FE-08: Rollback Lambda (origin path + invalidation)

**Story requirement:** 11 (SNS → Lambda rolls back if a deployment happened in the last X minutes,
switches to the previous release and invalidates the cache)
**Depends on:** FE-05, FE-07
**Branch:** `feature/frontend-rollback`

## Goal

When a frontend alarm fires shortly after a release, a Lambda switches the distribution back to the
previous good release and invalidates the cache, without anyone acting.

## Scope

- **Lambda** `rollback-factory-demo-frontend-rollback-<env>` in the alarms stack (us-east-1),
  Node 24, subscribed to the topic. Env vars:
  - main region, table name, frontend name
  - distribution ID, alarm names
  - `ROLLBACK_WINDOW_MINUTES` from `-c rollbackWindowMinutes` (default 30)
- **Behaviour on an SNS message:**
  1. ignore anything that isn't one of its own two alarms, or isn't `NewStateValue=ALARM`
  2. read the latest record (`current=true`) from the table (cross-region DynamoDB client)
  3. act only if all of these hold:
     - it is younger than X minutes
     - it is not itself a rollback
     - it is still what the distribution serves (origin path matches)
     - a target exists: the newest earlier record that is **verified** and never rolled back
  4. mark the bad record `rolledBackAt` / `stable=false` with a **conditional write**, so the 4xx
     and 5xx alarms together roll back only once
  5. switch the origin path to the target release and `CreateInvalidation /*` (shared
     `release-switch` code from FE-04)
  6. record a `source=rollback` record with `rolledBackFrom`
  7. log one structured line with the decision (skipped + why, or rolled back from → to)
- **IAM:** `cloudfront:GetDistributionConfig`, `UpdateDistribution`, `CreateInvalidation` on this
  distribution only; read/write on the table.
- `npm run rollback:trigger -- --env <env> [--alarm 4xx|5xx]` invokes the Lambda with a fake SNS
  alarm event, for demos.
- **Unit tests** with mocked clients: every skip reason, a successful rollback, a lost conditional
  write (second alarm), the target choice skips unverified and rolled-back records.

## Acceptance criteria

- On dev, `rollback:trigger` within X minutes of a release switches back to the previous verified
  release. The footer shows the old release id once the invalidation completes, and the table has a
  `rollback` record.
- Triggering again does nothing (the latest record is a rollback).
- Triggering more than X minutes after a release does nothing and logs why.

## Notes

- **CloudFormation drift:** after a rollback the origin path differs from the template. The next CI
  run reads it with `live:context` (FE-04), so `cdk deploy` keeps it.
- **Speed:** `UpdateDistribution` takes a few minutes to deploy, and the invalidation runs after that.
  The Lambda doesn't wait for either, so its timeout stays short (30 s).
- Alternative, out of scope: a CloudFront Function + KeyValueStore choosing the release would
  switch in seconds without a distribution update, but the story asks for the origin path.
