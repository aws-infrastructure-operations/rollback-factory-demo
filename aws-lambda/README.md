# service-lambda

A Lambda function (`service-lambda-<env>`) with **integration-first deploys** and a rollback system
for it, both automatic and manual. Ported from
[service-lambda-rollback](https://github.com/TudorIonutElian/service-lambda-rollback) and adapted to
this repo: one stack per environment (dev → testing → staging → prod), this repo's naming, and an
`integration` alias that every version is tested on before `live` gets it.

Every published version is archived: its metadata in DynamoDB and its package in S3 as
`<function>-<version>.zip`. A rollback never rebuilds anything: it points `live` at an archived
version and restores `$LATEST` from that version's zip.

## Names (per environment)

| Resource | Name |
|---|---|
| Stack | `rollback-factory-demo-lambda-<env>` |
| Service function + aliases | `service-lambda-<env>`, aliases `integration` and `live` |
| Errors alarm | `rollback-factory-demo-service-lambda-errors-<env>` |
| SNS topic | `rollback-factory-demo-lambda-notifications-<env>` |
| Rollback function | `rollback-factory-demo-lambda-rollback-<env>` |
| Versions table | `rollback-factory-demo-lambda-versions-<env>` |
| Artifacts bucket | `rollback-factory-demo-<account>-lambda-artifacts-<env>` |
| Scheduled check | `rollback-factory-demo-lambda-rollback-check-<env>` |

Stack outputs are exported as `rollback-factory-demo-lambda-<Output>-<env>`, so they never clash with
the api-user and frontend stacks in the same region. The versions table and artifacts bucket are
kept if the stack is deleted in prod only.

## How it works

### Deploy: integration first, then live

1. **`cdk deploy`** publishes a new, immutable version when the code or configuration changed, and
   points the **`integration`** alias at it. `live` stays where it is: CI passes
   `-c liveLambdaVersion=<what live serves>` (`npm run live:context`). On the very first deploy,
   `live` gets the new version directly.
2. **Integration tests** invoke `service-lambda-<env>:integration` (`npm run test:integration`,
   `LAMBDA_ALIAS=integration`). Calls to `integration` never count toward the errors alarm.
3. **Promote:** if they pass, `live` is pointed at the tested version (`npm run deployment:promote`).
   The update is conditional on the alias's revision, so it never overwrites a rollback that happened
   meanwhile.
4. **Sync:** the rollback function archives the version and records the deploy
   (`npm run deployment:sync`).

If the tests fail, the job stops: `live` was never touched. The failed version stays published and
archived, but it **never went live**, so no rollback ever goes back to it.

Each version's description is the last commit that touched `lambda/service/`.

### Sync / archive

For every registered function, the sync step:

1. Lists the function's published versions and archives each one not seen before: copies its package
   to `s3://<artifacts bucket>/<fn>/<fn>-<version>.zip` and writes its metadata to the versions table.
2. Compares the alias with the table's `CURRENT` record. If the alias was moved outside the rollback
   system (a promotion), it records the new version with the current time, marks that version as
   having gone live (`liveAt`), and resets the consecutive-rollback count.

Sync runs after every promotion, on every scheduled check and before every rollback.

### Automatic rollback

1. The errors alarm fires when there is at least 1 error in a minute on `service-lambda-<env>:live`
   or `$LATEST`.
2. The alarm publishes to the SNS topic, which invokes the rollback function.
3. **Pre-hook:** the function must be registered and enabled in `rollback-config.json`, and the alarm
   must be registered for it.
4. The rollback function gets temporary credentials scoped to that single function: its alias and
   versions, its S3 folder and its DynamoDB items (STS `AssumeRole` with a session policy).
5. It syncs, then applies the [rollback guards](#rollback-guards).
6. It moves `live` to the **newest older version that went live and was never rolled back from**,
   restores `$LATEST` from that version's zip in S3, and records the rollback in DynamoDB.

### $LATEST-only failures

If new code reaches `$LATEST` without the alias moving, calls to the bare function can fail while
`live` is fine. This also happens after every deploy until promotion, and after a deploy whose tests
failed. Before rolling back the alias, the rollback function checks for this:

1. It compares `$LATEST`'s code hash with the live version's archived code hash.
2. If they differ, it reads the alias's own `Errors` metric for the last 5 minutes.
3. If the alias had no errors, only `$LATEST` is failing: it restores `$LATEST` from the live
   version's zip and leaves the alias where it is. If the alias also had errors, it does a normal
   alias rollback (which restores `$LATEST` too).

A `$LATEST`-only revert uses the same deployment window, measured from `$LATEST`'s last code change,
and starts the cooldown. It doesn't count towards `maxConsecutiveRollbacks`. It is recorded on
`CURRENT` as `lastLatestRevertAt`, `latestRevertedFromSha`, `latestRevertedToVersion` and
`latestRevertReason`.

### Rollback guards

An automatic rollback is skipped, with a log line saying why, when any of these applies:

| Guard | Rule | Configured by |
|---|---|---|
| Not registered | The function isn't in `rollback-config.json`, is `"enabled": false`, or the alarm isn't one of its `alarms` | `rollback-config.json` |
| Deployment window | No deploy or rollback was recorded in the last N minutes, so the alarm isn't blamed on a change | `deploymentWindowMinutes` (default 10) |
| Cooldown | The last rollback (or `$LATEST` revert) was less than 3 minutes ago | `ROLLBACK_SETTINGS.cooldownMinutes` |
| Limit | Already rolled back N times in a row since the last deploy | `maxConsecutiveRollbacks` (default 2) |
| Nothing to roll back to | No older version that went live and was never rolled back from | — |

The deployment window is measured from `CURRENT.updatedAt`: the time of the last rollback, or the
time sync recorded the last promotion.

### Scheduled check

Every 5 minutes the scheduled check:

1. **Syncs** every registered function.
2. **Marks stable versions:** if all of a function's registered alarms are `OK` and its live version
   has been live for at least 5 minutes, that version gets `stable: true` and `stableAt`. A version
   later rolled back from gets `stable: false`, `stableForSeconds` and `stableFor` (e.g. `2h 30m`, or
   `not marked stable while live`).
3. **Re-checks alarms:** CloudWatch only notifies on state changes, so any registered alarm still in
   `ALARM` is handled as if it had just fired, subject to the same guards.

### Manual rollback

Two workflows, both with an **environment** choice:

- **`lambda rollback by version`:** leave `target_version` empty to go back to the previous version
  that went live, or enter any archived version. A version that never went live is allowed when
  chosen by hand, with a warning.
- **`lambda rollback to commit`:** pick one of the last 5 commits that went live in dev, e.g.
  `abc1234 Fix greeting`. It resolves the commit to the newest version in the chosen environment
  that was built from it and went live, then runs `lambda rollback by version` with it. Version
  numbers differ per environment, which is why it resolves the commit rather than a version.

Both stop if a `lambda` deploy is running or queued (a dry run only warns), sync, move `live` back,
restore `$LATEST` from S3 and record the rollback. A manual rollback starts the cooldown but doesn't
count towards the consecutive-rollback limit. Tick `dry_run` to only list the archived versions.

**The commit dropdown:** GitHub can't fill a dropdown at run time, so after every deploy to dev from
`main`, the `lambda` workflow's `update-commit-dropdown` job rewrites the options between the
`# BEGIN/END generated commit options` markers in `lambda-rollback-to-commit.yml` and pushes the
change to `main`. The commit is marked `[skip ci]` and the file is excluded from the workflow's push
paths, so it doesn't start another deploy. Pushing a workflow file needs a token with `workflow`
scope: add a fine-grained token with **Contents** and **Workflows** read/write as the `WORKFLOW_PAT`
secret. Without it, the job only warns and the dropdown keeps its options.

## Version metadata (DynamoDB)

Partition key `functionName`, sort key `sk`:

| `sk` | Attributes |
|---|---|
| `VERSION#0000000003` | `version`, `codeSha256`, `description`, `lastModified`, `runtime`, `handler`, `memorySize`, `timeout`, `codeSize`, `s3Bucket`, `s3Key`, `archivedAt`; once promoted: `liveAt`; once its alarms stayed OK while live: `stable`, `stableAt`; after a rollback away from it: `rolledBackAt`, `rolledBackBy`, `rollbackReason`, `stable: false`, `stableForSeconds`, `stableFor` |
| `CURRENT` | `version` the alias points to, `previousVersion`, `updatedBy` (`deploy` / `auto-rollback` / `manual-rollback`), `updatedAt`, `lastRollbackAt`, `rollbackCount`, `stable`, `stableAt`; after a `$LATEST`-only revert: `lastLatestRevertAt`, `latestRevertedFromSha`, `latestRevertedToVersion`, `latestRevertReason` |

## Registering a function for automatic rollback

Edit [`rollback-config.json`](rollback-config.json) and deploy. `<env>` in names is replaced with the
environment:

```json
{
  "maxConsecutiveRollbacks": 2,
  "deploymentWindowMinutes": 10,
  "functions": [
    { "name": "service-lambda-<env>", "enabled": true, "alias": "live", "alarms": ["rollback-factory-demo-service-lambda-errors-<env>"] }
  ]
}
```

| Field | Where | Default | Meaning |
|---|---|---|---|
| `maxConsecutiveRollbacks` | top level / function | `2` | Automatic rollbacks in a row before giving up; resets on the next deploy. `0` on a function turns automatic rollback off |
| `deploymentWindowMinutes` | top level / function | `10` | Automatic rollback only within this many minutes of a deploy or rollback |
| `name` | function | required | Lambda function name |
| `alarms` | function | `[]` | Alarms allowed to trigger this function's rollback |
| `alias` | function | `live` | Alias to roll back |
| `enabled` | function | `true` | `false` deregisters the function without removing the entry |

The function must publish versions, have the alias, and be packaged as a zip. Its alarm must send to
the rollback topic. Permissions, the scheduled check and the sync are generated from this file.

## Settings

`ROLLBACK_SETTINGS` in [`lib/config.ts`](lib/config.ts):

| Setting | Default | Meaning |
|---|---|---|
| `checkIntervalMinutes` | `5` | How often the scheduled check runs |
| `cooldownMinutes` | `3` | Minimum time between two rollbacks of the same function |
| `stableAfterMinutes` | `5` | How long a version must be live, with all its alarms OK, before it is marked stable |
| `liveErrorsLookbackMinutes` | `5` | How far back to look for errors on the alias when deciding whether only `$LATEST` is failing |

## Rollback function invocations

| Event | Sent by | What it does |
|---|---|---|
| SNS record with a CloudWatch alarm message | the errors alarm, via the topic | Automatic rollback for the alarm's function |
| `{ "type": "scheduled-check" }` | the EventBridge rule | Sync, mark stable versions, re-check alarms |
| `{ "type": "sync", "functionName": "<fn>" }` | the deploy (after promotion) and the manual rollbacks | Sync one function (all, without `functionName`) |

## Layout

| Path | Contents |
|---|---|
| `lib/config.ts` | Environments, names, `ROLLBACK_SETTINGS` |
| `lib/lambda-service-stack.ts` | The stack: function, `integration` and `live` aliases, alarm, topic, schedule, table, bucket, rollback function, IAM |
| `lambda/service/` | The demo service (returns the version it runs as) |
| `lambda/rollback/` | The rollback function in TypeScript: `rollback.ts` (sync, alarms, guards, rollback), `store.ts` (versions table), `scoped.ts` (scoped credentials), `registry.ts` (`rollback-config.json`), `handler.ts` |
| `scripts/` | `live:context`, `deployment:promote`, `deployment:sync`, `versions:list` |
| `integration/` | Integration tests against an alias |
| `test/` | Unit tests: config, stack, rollback logic, and the rollback flows against an in-memory fake of Lambda, DynamoDB, S3 and CloudWatch |

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| [`lambda`](../.github/workflows/lambda.yml) | PRs; pushes to `main` touching `aws-lambda/**`; manual | PRs: typecheck, unit tests, synth. `main`: deploy dev → testing → staging → prod through [`lambda-deploy`](../.github/workflows/lambda-deploy.yml) (integration → tests → live → sync), then refresh the commit dropdown |
| [`lambda rollback by version`](../.github/workflows/lambda-rollback-by-version.yml) | Manual: environment, `target_version`, `dry_run` | See [Manual rollback](#manual-rollback) |
| [`lambda rollback to commit`](../.github/workflows/lambda-rollback-to-commit.yml) | Manual: environment, `commit`, `dry_run` | Resolves the commit to a version in that environment, then runs rollback by version |

Deploys and manual rollbacks of the same environment share the lock `lambda-release-<env>`.
Secrets per GitHub environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, variable `AWS_REGION`;
optionally `WORKFLOW_PAT` (repository secret) for the dropdown.

## Scripts

| Command | Does |
|---|---|
| `npm run build` / `npm test` | typecheck / unit tests |
| `npm run synth:dev` / `synth:prod` | synthesize the stack |
| `LAMBDA_ENV=<env> [LAMBDA_ALIAS=live] npm run test:integration` | integration tests against an alias (default `integration`) |
| `npm run live:context -- --env <env>` | print `-c liveLambdaVersion=<n>` for `cdk deploy` |
| `npm run deployment:promote -- --env <env> [--version <n>]` | point `live` at what `integration` serves |
| `npm run deployment:sync -- --env <env>` | archive versions and record the deploy |
| `npm run versions:list -- --env <env>` | archived versions and which alias serves each |

## Testing an automatic rollback

1. Deploy a good version through CI (it goes live and is archived).
2. Deploy a version whose handler throws but passes CI, e.g. one that only fails for real traffic,
   or promote one by hand with `deployment:promote`.
3. Within the deployment window (10 minutes), invoke `service-lambda-<env>:live` a few times.
4. Within 1–3 minutes the alarm fires and `live` moves back. `CURRENT` shows
   `updatedBy: auto-rollback`, and the bad version's item gets `rolledBackBy`.

A version that throws on every call is stopped earlier: the integration tests fail on `integration`
and it never reaches `live`.

## Things to know

- Clients must call the function through `live`. Unqualified calls run `$LATEST`, which holds the
  newest deployed code (even untested) until the next rollback or promotion.
- After a rollback, `$LATEST` no longer matches git until the next deploy that changes the service code.
- A failure that starts long after a deploy (e.g. a downstream outage) doesn't trigger a rollback,
  because of the deployment window.
- [Cost estimate for 500 functions](docs/COSTS.md) (from the original repo; it uses the old
  single-environment names).
