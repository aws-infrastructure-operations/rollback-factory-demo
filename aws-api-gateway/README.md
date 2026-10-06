# aws-api-gateway

AWS CDK (TypeScript) app for the `api-user-<env>` REST API. Implementation plan: [story-implementation.md](story-implementation.md).

## What gets deployed (per environment)

| Resource | Name |
|---|---|
| REST API (regional) | `api-user-dev` / `api-user-prod`, stage `v1` |
| Cognito user pool + app client | `api-user-<env>-users` / `api-user-<env>-client` |
| Cognito authorizer | `api-user-<env>-cognito` (`Authorization: <ID token>`) |
| Lambda backend (Node 24, arm64) | `api-user-<env>-handler` |
| S3 bucket (versioned) for OpenAPI specs | `api-user-<env>-<account>-deployments` |
| DynamoDB deployments table | `api-user-<env>-deployments` |
| CloudWatch alarms (4xx rate, 5xx rate) | `api-user-<env>-v1-4xx-rate`, `api-user-<env>-v1-5xx-rate` |
| SNS alarm topic | `api-user-<env>-alarms` |
| Rollback Lambda | `api-user-<env>-rollback` |

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

Stack outputs (exported as `api-user-<env>-<Name>`): `ApiId`, `ApiUrl`, `StageName`, `UserPoolId`, `UserPoolClientId`, `SpecBucketName`, `DeploymentsTableName`, `AlarmTopicArn`, `Alarm4xxName`, `Alarm5xxName`, `RollbackFunctionName`.

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
3. uploads it to `s3://api-user-<env>-<account>-deployments/specs/<yyyymmddThhmmssZ>/openapi.json`
4. writes an item to `api-user-<env>-deployments`:

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

For each run, the suite creates a throwaway Cognito user with a random password and deletes it afterwards, so CI needs only AWS credentials.
To test as an existing user instead, set `API_USERNAME` and `API_PASSWORD`.
The 3 negative tests do add to the API's 4XXError metric, so keep them few.

## Alarms & automatic rollback

```
4xx / 5xx alarm ──► SNS api-user-<env>-alarms ──► rollback Lambda ──► PutRestApi(previous spec) + CreateDeployment(v1)
                                          └─► optional e-mail
```

**Alarms.** Each alarm watches the share of 4xx or 5xx responses per minute on stage `v1`:

| Alarm | Fires when | Ignores minutes with |
|---|---|---|
| 4xx | > 25 % of requests in 2 of 3 minutes | < 20 requests |
| 5xx | > 5 % of requests in 2 of 3 minutes | < 5 requests |

Minutes with fewer requests than the minimum are ignored, so a handful of intentional 401/400 responses (such as the integration tests) can't trigger a rollback.

**Rollback Lambda.** When an alarm enters `ALARM`, the Lambda:
1. loads the deployment history and **only acts if the latest deployment is younger than the rollback window** (default 30 min), is not itself a rollback, and has an earlier deployment to go back to
2. claims the bad deployment record (`rolledBackAt`), so the 4xx and 5xx alarms firing together roll back only once
3. downloads the previous deployment's OpenAPI spec from S3, re-imports it with `PutRestApi mode=overwrite` and redeploys stage `v1`
4. records the rollback in the table (`source=rollback`, `rolledBackFrom=<bad deployedAt>`) with its own spec export

**Code rollback.** The API integrates with a *published Lambda version* instead of `$LATEST`, so every exported spec pins the exact backend code it ran with. Re-importing an old spec therefore rolls back the Lambda code too. Old versions are retained, and the rollback Lambda gives API Gateway permission again to invoke the version it restores.

### Options (CDK context)

| Context | Default | |
|---|---|---|
| `-c alarmNotifications=false` | `true` | turn the alarm actions (SNS -> rollback) off; the alarms still change state |
| `-c alarmEmail=ops@example.com` | – | also subscribe an e-mail to the topic |
| `-c rollbackWindowMinutes=15` | `30` | the "X minutes" after a deployment in which rollbacks happen |
| `-c chaosFailureRate=1` | `0` | share of requests the backend fails with 500, to demo a rollback |

### Demo a rollback

```bash
npm run deploy:dev                                  # good deployment (recorded)
npx cdk deploy -c env=dev -c chaosFailureRate=1 --require-approval never   && npm run deployment:record -- --env dev         # bad deployment (all 500s)
API_ENV=dev npm run test:integration                # generate traffic -> 5xx alarm in ~2-3 min
npm run deployment:list -- --env dev                # shows the rollback record
```

To exercise the rollback logic without waiting for real errors, run `npm run rollback:trigger -- --env dev [--alarm 4xx|5xx] [--reason "..."]`. It invokes the rollback Lambda with an ALARM event, the same way SNS does. CI uses it when integration tests fail.

> After a rollback the live API config differs from what CloudFormation last applied. CloudFormation only updates the API resources whose template changed, so after rolling forward, check that the stage behaves as expected; the integration tests do that in CI.

## CI/CD (GitHub Actions)

[`.github/workflows/api-gateway.yml`](../.github/workflows/api-gateway.yml) runs when `aws-api-gateway/**` changes. It calls [`api-gateway-deploy.yml`](../.github/workflows/api-gateway-deploy.yml) once per environment.

```
PR ───────► test (typecheck, unit tests, synth dev+prod, Bruno collection up to date)

main / manual ─► test ─► deploy dev ──────────────────────────► deploy prod (same steps)
                         ├ cdk bootstrap
                         ├ create / update Bruno collection (uploaded as artifact)
                         ├ cdk deploy
                         ├ record deployment (spec -> S3, record -> DynamoDB)
                         ├ integration tests ── fail ─► rollback:trigger, job fails
                         ├ bake: watch 4xx/5xx alarms ── ALARM ─► wait for the rollback Lambda, job fails
                         └ deployment history -> job summary
```

Prod is deployed only when dev passes all steps, including the bake.
A manual run (`workflow_dispatch`) can skip prod, change the bake times, or set `dev_chaos_failure_rate=1` to demo a rollback in dev.

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
- API Gateway `GET` (exports)
- S3 `PutObject` on the spec bucket
- DynamoDB on the deployments table
- `cloudwatch:DescribeAlarms`
- `lambda:InvokeFunction` on the rollback Lambda

Add required reviewers to the `prod` environment if promotions should wait for an approval.
