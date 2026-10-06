# aws-api-gateway

AWS CDK (TypeScript) app for the `api-user-<env>` REST API. Implementation plan: [story-implementation.md](story-implementation.md).

## What gets deployed (per environment)

| Resource | Name |
|---|---|
| REST API (regional) | `api-user-dev` / `api-user-prod`, stage `v1` |
| CloudFormation stack | `rollback-factory-demo-<env>` |
| Cognito user pool + app client | `rollback-factory-demo-users-<env>` / `rollback-factory-demo-client-<env>` |
| Cognito authorizer | `rollback-factory-demo-cognito-<env>` (`Authorization: <ID token>`) |
| Lambda backend (Node 24, arm64) | `rollback-factory-demo-handler-<env>`, aliases `live` (stage `v1`) and `integration` (stage `integration`) |
| API stages | `v1` (clients) and `integration` (CI tests each deploy here before it is promoted to `v1`) |
| S3 bucket (versioned) for OpenAPI specs | `rollback-factory-demo-<account>-deployments-<env>` |
| DynamoDB deployments table | `rollback-factory-demo-deployments-<env>` |
| CloudWatch alarms (4xx rate, 5xx rate) | `rollback-factory-demo-4xx-rate-<env>`, `rollback-factory-demo-5xx-rate-<env>` |
| SNS notification topic | `rollback-factory-demo-notifications-<env>` |
| Rollback Lambda | `rollback-factory-demo-rollback-<env>` |
| Lambda 4xx / 5xx rate alarms (block the API rollback) | `rollback-factory-demo-lambda-4xx-rate-<env>`, `rollback-factory-demo-lambda-5xx-rate-<env>` |
| Lambda errors alarm (informational, no rollback) | `rollback-factory-demo-lambda-errors-<env>` |
| API access logs (JSON, 30 days) | `rollback-factory-demo-api-access-logs-<env>` |
| Saved Logs Insights queries | `rollback-factory-demo-api-5xx-by-cause-<env>`, `rollback-factory-demo-api-5xx-requests-<env>` |

The REST API keeps the `api-user-<env>` name from the story. Every other resource is named `rollback-factory-demo-<resource>-<env>`, built by `resourceName()` in [`lib/config.ts`](lib/config.ts).

### Endpoints

All methods need a Cognito ID token in the `Authorization` header.

| Method | Path | Body |
|---|---|---|
| GET | `/users` | – |
| POST | `/users` | `{ "message": "..." }` (validated) |
| GET | `/messages` | – |
| POST | `/messages` | `{ "message": "..." }` (validated) |

## Usage

```bash
npm ci
npm test                 # CDK assertion tests
npm run synth:dev        # cdk synth -c env=dev
npm run deploy:dev       # collection sync -> cdk deploy -> record deployment
npm run deploy:prod
```

The first deploy to an account/region needs `npx cdk bootstrap`.

Stack outputs (exported as `rollback-factory-demo-<Name>-<env>`): `ApiId`, `ApiUrl`, `StageName`, `UserPoolId`, `UserPoolClientId`, `SpecBucketName`, `DeploymentsTableName`, `AlarmTopicArn`, `Alarm4xxName`, `Alarm5xxName`, `RollbackFunctionName`.

## Bruno collection & Cognito token

The [`bruno/`](bruno) collection is generated from the CDK stack, so it always matches the deployed API.
Run the sync before each deploy:

```bash
npm run collection:sync -- --env dev   # synth -> one request per method + environments/dev.bru from stack outputs
```

The sync overwrites the generated requests (the ones with the marker in their `docs` block) and deletes those for removed routes. Requests you add by hand are not touched.
If the stack isn't deployed yet, or no AWS credentials are available, the environment file keeps its previous values.

Get a token (the Cognito **ID token**, sent raw in the `Authorization` header):

```bash
export API_USERNAME=me@example.com API_PASSWORD='...'
npm run user:create -- --env dev               # once: creates a confirmed user (or resets its password)
npm run token -- --env dev                     # prints the ID token to stdout
npm run token -- --env dev --write-env         # also writes ID_TOKEN_DEV to bruno/.env (gitignored)
```

Then open `bruno/` in Bruno, or use the CLI: `cd bruno && npx @usebruno/cli run --env dev`.

## Deployment history

Every deployment of stage `v1` is recorded by `npm run deployment:record -- --env <env>`. `deploy:<env>` runs it automatically, and CI will run it too. The script:

1. reads the deployment id the stage currently points to (if it matches the latest record, nothing changed and nothing is recorded; `--force` overrides)
2. exports the stage as OpenAPI 3 JSON **with API Gateway extensions** (integrations, authorizers, validators), so it can be re-imported for a rollback
3. uploads it to `s3://rollback-factory-demo-<account>-deployments-<env>/<apiName>/<yyyymmddThhmmssZ>/openapi.json` (one folder per API, e.g. `api-user-dev/`, holding one folder per deployment)
4. writes an item to `rollback-factory-demo-deployments-<env>`:

| Attribute | Example |
|---|---|
| `apiName` (PK) | `api-user-dev` |
| `deployedAt` (SK) | `2026-10-06T12:30:05.123Z` |
| `deploymentId`, `restApiId`, `stageName` | API Gateway ids |
| `specBucket`, `specKey` | where the spec lives |
| `source` | `manual`, `cicd` (inside GitHub Actions) or `rollback` |
| `actor` | caller's IAM ARN, or `github:<actor>` |
| `commitSha`, `runUrl`, `description`, `rolledBackFrom` | optional context |

`npm run deployment:list -- --env dev` shows the latest records. The logic lives in [`lambda/shared/deployments.ts`](lambda/shared/deployments.ts) so the rollback Lambda can reuse it.

> Deployments made outside these scripts (e.g. "Deploy API" in the console) are not recorded.

## Integration tests

[`integration/`](integration) holds tests that run against the **deployed** API of `API_ENV` (default `dev`):

```bash
API_ENV=dev npm run test:integration            # bash
$env:API_ENV='dev'; npm run test:integration    # PowerShell
```

The tests cover:
- `GET` and `POST` on `/users` and `/messages` with a valid token (200 / 201, echoed message, caller email)
- requests with no token or an invalid token get 401
- a `POST` body without `message` gets 400 from the request validator
- CORS: `OPTIONS` preflights answer with `Access-Control-Allow-Origin: *`, and so do normal responses and API Gateway's own errors (the browser frontend needs this)

For each run, the suite creates a throwaway Cognito user with a random password and deletes it afterwards, so CI needs only AWS credentials.
To test as an existing user instead, set `API_USERNAME` and `API_PASSWORD`.
The 4 intentional 4xx calls do add to the API's 4XXError metric, so keep them few.

## Alarms & automatic rollback

```
4xx / 5xx alarm ──► SNS rollback-factory-demo-notifications-<env> ──► rollback Lambda ──► PutRestApi(previous spec) + CreateDeployment(v1)
                                          └─► optional e-mail
```

**Alarms.** Each alarm watches the share of 4xx or 5xx responses per minute on stage `v1`:

| Alarm | Fires when | Ignores minutes with |
|---|---|---|
| 4xx | > 25 % of requests in 2 of 3 minutes | < 20 requests |
| 5xx | > 5 % of requests in 2 of 3 minutes | < 5 requests |

Minutes with fewer requests than the minimum are ignored, so a handful of intentional 401/400 responses (such as the integration tests) can't trigger a rollback.

**Rollback Lambda.** When an alarm enters `ALARM`, the Lambda:
1. loads the deployment history and **only acts if the latest deployment is younger than the rollback window** (default 30 min) and is not itself a rollback or restore
2. checks that the errors are **not the backend Lambda's fault** (see below). An API rollback can't fix those, so it is skipped
3. picks the target: the newest earlier deployment that is **verified** (it passed the integration tests, `verifiedAt`) and was never rolled back. It never just takes "the previous deployment", which may be untested or broken. No verified target means no rollback.
4. claims the bad deployment record (`rolledBackAt`), so the 4xx and 5xx alarms firing together roll back only once, and marks it unstable (`stable=false`, no `stableFor` / `stableForHumanReadable`)
5. downloads the target's OpenAPI spec from S3, points its integrations at the stage's alias (`live` for `v1`), re-imports it with `PutRestApi mode=overwrite` and redeploys stage `v1`
6. records the rollback in the table (`source=rollback`, `rolledBackFrom=<bad deployedAt>`) with its own spec export. It inherits the target's `verifiedAt`, since it serves the same spec.

**Current and stable deployments.** The record the stage serves has `current=true`. Recording a new deployment (deploy, rollback or restore) moves `current` to it and, in the same transaction, marks the previous one `stable=true` with `stableFor` = seconds between its deployment and the next one, and `stableForHumanReadable` = the same as text (e.g. `2 days 3 hours 15 minutes`; seconds only below a minute). A deployment an alarm rolled back is instead left `stable=false` without either. `npm run deployment:list` shows both.

**Verified deployments.** CI runs `npm run deployment:verify -- --env <env>` after the integration tests pass. It marks the deployment the stage serves as verified, after checking that it is the latest record.
A deployment made by hand only becomes a rollback target after you run the integration tests and then `deployment:verify`.

**Restoring a chosen deployment.** If the live API is in a bad state the automatic rollback won't fix (for example, no verified target), restore any recorded deployment:
- GitHub: Actions → `api-gateway-restore` → Run workflow with the environment and the `deployed_at` value (from `npm run deployment:list` or a deploy run's job summary). The workflow restores that deployment, runs the integration tests and marks it verified if they pass.
- Locally: `npm run deployment:restore -- --env dev --to <deployedAt> [--reason "..."]`, then the integration tests and `deployment:verify`.

The rollback Lambda does the restore (`source=restore` in the history). A restored deployment counts as unverified until the tests pass again.

**API rollbacks keep the latest code.** Each stage invokes the handler through the alias its `lambdaAlias` stage variable names: `v1` → `live`, `integration` → `integration` (see [CI/CD](#cicd-github-actions) for how they move). A rollback or restore only brings back the API config (routes, authorizer, validators, integrations). Before re-importing a spec, the rollback Lambda points its integrations at the stage's alias, including specs recorded with a fixed version or alias.

**Is the Lambda at fault?** Each API alarm has a paired Lambda alarm with the same threshold. It counts only the 4xx / 5xx of requests that reached the Lambda: the access-log line has a `lambdaRequestId`, so the Lambda returned, threw or timed out. Errors API Gateway produced on its own (authorizer, validator, unknown route, throttling, invoke permissions) are left out. When an API alarm fires, the rollback Lambda skips the rollback if
- the paired Lambda alarm (`rollback-factory-demo-lambda-<4xx|5xx>-rate-<env>`) is in `ALARM`, or
- the Lambda produced at least half of the API's 4xx / 5xx in the last 3 minutes. Both alarms are evaluated independently, so the Lambda alarm may not have fired yet.

A broken Lambda deploy is therefore **not** rolled back automatically. Fix it forward, or redeploy a previous commit.

### Options (CDK context)

| Context | Default | |
|---|---|---|
| `-c alarmNotifications=false` | `true` | turn the alarm actions (SNS -> rollback) off; the alarms still change state |
| `-c alarmEmail=ops@example.com` | – | also subscribe an e-mail to the topic |
| `-c rollbackWindowMinutes=15` | `30` | the "X minutes" after a deployment in which rollbacks happen |
| `-c chaosFailureRate=1` | `0` | share of requests the backend fails with 500, to demo a skipped rollback (Lambda at fault) |

### Demo a rollback

```bash
npm run deploy:dev                                  # good deployment (recorded)
npx cdk deploy -c env=dev -c chaosFailureRate=1 --require-approval never   && npm run deployment:record -- --env dev         # bad deployment (all 500s)
API_ENV=dev npm run test:integration                # generate traffic -> 5xx alarm in ~2-3 min
```

The 500s come from the Lambda, so the `lambda-5xx-rate` alarm fires too and the rollback Lambda logs `rollback skipped: errors come from the backend Lambda`. Only an API-side failure (e.g. a broken route or integration config) is rolled back.

To exercise the rollback logic without waiting for real errors, run `npm run rollback:trigger -- --env dev [--alarm 4xx|5xx] [--reason "..."]`. It invokes the rollback Lambda with an ALARM event, the same way SNS does.

> After a rollback the live API config differs from what CloudFormation last applied. CloudFormation only updates the API resources whose template changed, so after rolling forward, check that the stage behaves as expected; the integration tests do that in CI.

## Troubleshooting 5xx: API Gateway or Lambda?

The 5xx alarm counts every 5xx the client received, whatever caused it. To find the cause, use the access logs and the Lambda-errors alarm.

**1. Access logs.** Every request to stage `v1` is logged as one JSON line in `rollback-factory-demo-api-access-logs-<env>`:

| Field | Meaning |
|---|---|
| `status` | what the client got |
| `errorType` | set when **API Gateway** produced the error, e.g. `INTEGRATION_FAILURE`, `INTEGRATION_TIMEOUT`, `AUTHORIZER_FAILURE`, `UNAUTHORIZED`, `BAD_REQUEST_BODY`, `THROTTLED`; empty when the Lambda's response was passed through |
| `integrationStatus` | status code returned by the **function code** |
| `lambdaServiceStatus` | status of the call to the **Lambda service** itself |
| `integrationError`, `integrationErrorMessage` | why the integration failed, e.g. the function's error, or "Invalid permissions on Lambda function" |
| `lambdaRequestId` | same as `RequestId:` in the Lambda's log; find the stack trace with it |

In CloudWatch → Logs Insights → **Saved queries**:
- `rollback-factory-demo-api-5xx-by-cause-<env>`: counts the 5xx grouped by `errorType` / `integrationStatus` / `integrationErrorMessage`
- `rollback-factory-demo-api-5xx-requests-<env>`: the latest 5xx requests, with `lambdaRequestId`

How to read them:

| You see | Cause |
|---|---|
| 502, `errorType=INTEGRATION_FAILURE`, `integrationError` set | the **Lambda** threw or returned an invalid response (e.g. `demo/break-api`) |
| 5xx, `errorType` empty, `integrationStatus` = the same 5xx | the **Lambda code** returned the 5xx on purpose (e.g. `chaosFailureRate`) |
| 504, `errorType=INTEGRATION_TIMEOUT` | the Lambda was slower than API Gateway's 29 s limit |
| 500, `integrationErrorMessage` about permissions | **API Gateway** configuration, e.g. a missing invoke permission for the Lambda version |
| no `lambdaRequestId` | the request never reached the Lambda (authorizer, validator, throttling, routing) |

**2. The paired Lambda alarms.** `rollback-factory-demo-lambda-4xx-rate-<env>` / `-lambda-5xx-rate-<env>` fire on the same rates as the API alarms, counting only the errors of requests that reached the Lambda (metric filters on the access logs, namespace `rollback-factory-demo/api-user-<env>`). API alarm + Lambda alarm → the code; API alarm alone → API Gateway. See "Is the Lambda at fault?" above.

**3. The Lambda-errors alarm.** `rollback-factory-demo-lambda-errors-<env>` fires when the backend Lambda (any version) throws unhandled errors in 2 of 3 minutes:
- 5xx alarm + Lambda-errors alarm together → the **code** is failing.
- 5xx alarm alone → API Gateway, a timeout, or 5xx responses the code returns on purpose.

It notifies the SNS topic, so e-mail subscribers see it, but it **never triggers a rollback**: the rollback Lambda's subscription only accepts the 4xx and 5xx alarms.

Logging needs API Gateway's account-level CloudWatch role. The stack creates that role and keeps it if the stack is deleted, because it is one setting shared by every API in the account and region.

## CI/CD (GitHub Actions)

[`.github/workflows/api-gateway.yml`](../.github/workflows/api-gateway.yml) runs when `aws-api-gateway/**` changes. It calls [`api-gateway-deploy.yml`](../.github/workflows/api-gateway-deploy.yml) once per environment.

```
PR ───────► test (typecheck, unit tests, synth dev+prod, Bruno collection up to date)

main / manual ─► test ─► deploy dev ──────────────────────────► deploy prod (same steps)
                         ├ cdk bootstrap
                         ├ create / update Bruno collection (uploaded as artifact)
                         ├ live:context (what v1 and the live alias serve now)
                         ├ cdk deploy -> stage integration + alias integration (v1 untouched)
                         ├ integration tests on stage integration ── fail ─► failures -> job summary, stop
                         ├ deployment:promote (v1 -> tested deployment, alias live -> tested version)
                         ├ record deployment (spec -> S3, record -> DynamoDB)
                         ├ mark deployment verified (only verified deployments are rollback targets)
                         └ deployment history -> job summary
```

**Integration stage.** `cdk deploy` in CI gets `-c liveDeploymentId=... -c liveLambdaVersion=...` from `npm run live:context`, so CloudFormation keeps stage `v1` on the deployment it serves and the `live` alias on its version. Only stage `integration` and the `integration` alias get the new API config and code. The tests run there (`API_STAGE=integration npm run test:integration`). If they pass, `npm run deployment:promote` points `v1` at the tested deployment and `live` at the tested version. If they fail, the job stops: `v1` was never changed, so there is nothing to roll back, and the test output goes to the job summary.
A `cdk deploy` without that context (e.g. `npm run deploy:dev`, or the break-api demo) updates `v1` and both aliases directly.

Prod is deployed only when every dev step passes, including the integration tests.
The workflow does not watch the alarms after a deploy; that part is done in AWS. A 4xx or 5xx alarm notifies SNS, which invokes the rollback Lambda (see [Alarms & automatic rollback](#alarms--automatic-rollback)), whether or not a workflow is running.
A manual run (`workflow_dispatch`) can skip prod, or set `dev_chaos_failure_rate=1`: the integration tests then fail on the integration stage and `v1` stays as it is.

### Rollback demo (manual workflow)

[`break-api-demo.yml`](../.github/workflows/break-api-demo.yml) (Actions → `break-api-demo` → Run workflow) demonstrates the alarm-driven rollback in **dev** without merging anything:

1. **preflight:** checks that dev has a recorded deployment to roll back to (deploy `main` first)
2. **deploy:** deploys the broken branch (`broken_ref`, default `demo/break-api`) to dev and records the deployment
3. **traffic:** `npm run demo:traffic` sends real HTTPS requests for `traffic_minutes` (default 10), logs the status codes every 30 s, then the job finishes. The console's "Test" button bypasses the stage, so it never counts toward the alarms.

The workflow does **not** roll back and doesn't wait for a rollback. That's left to AWS: the 5xx alarm notifies SNS, which invokes the rollback Lambda, usually a few minutes into the traffic.
You'll see it in the traffic log (502s turn back into 200s), in the alarm, in the logs of `rollback-factory-demo-rollback-dev`, and in the job summary's deployment history (a `rollback` record).

The broken branch is only checked out and deployed; the scripts come from `main`.
A shared concurrency group stops this demo and a normal dev deploy from running at the same time.
If `main` changes the infrastructure, rebase `demo/break-api` on `main` first, so the demo deploys the current stack plus the bug.

### Setup

Create two GitHub **environments**, `dev` and `prod`, in Settings -> Environments.
Each needs:

| Kind | Name | Value |
|---|---|---|
| secret | `AWS_ACCESS_KEY_ID` | access key of a deploy user for that account |
| secret | `AWS_SECRET_ACCESS_KEY` | its secret key |
| variable | `AWS_REGION` | e.g. `eu-west-1` |

The deploy user needs CDK deploy rights (or permission to assume the CDK bootstrap roles), plus everything the scripts use:
- read the CloudFormation stack outputs
- Cognito admin user calls (create/delete the throwaway test user)
- API Gateway `GET` (exports, stages) and `PATCH` on the stages (promotion)
- `lambda:GetAlias` and `lambda:UpdateAlias` on the handler (promotion, records)
- S3 `PutObject` on the spec bucket
- DynamoDB on the deployments table
- `lambda:InvokeFunction` on the rollback Lambda

Add required reviewers to the `prod` environment if promotions should wait for an approval.
