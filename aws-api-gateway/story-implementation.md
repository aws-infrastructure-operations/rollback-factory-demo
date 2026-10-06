## For each feature create a new branch from origin main and raise a PR or let me raise it

1. Build an API gateway with stage deployment
 - we need to use AWS CDK with typescript here
 - api name should be api-user-dev/prod
 - api should be simple and to have 2 enpoints with GET and POST message both
 - api should use cognito as authorizer (you can create a lambda for it)
 - before deploying the API, 
    - create / update a collection for postman / bruno to call the endpoints and a script to get the token from cognito
    - store the API gateway JSON/yaml openAPI spec file into a s3 bucket with the name (apigatewayname-awsaccount-deployments-datetimestamp)
 - add a dynamodb table to record each deployment made (manually or automatic via CICD)
 - add integration steps for the API gateway
 - for the API gateway create an ALARM for 4xx and one for 5xx and which has as option to send an sns notification
 - sns notification should invoke a lambda which can perform rollback on the API gateway stage and assuming something is wrong and if a deployment was made in the past X minutes. Will look at the previous version of the API gateway JSON/yaml and redeploy that by overriding the stage v1
  - we should have a github workflow to
    - deploy the api with everythign I've said earlier (record, store yaml/json)
    - run integration testing
    - move to prod API if everything is green
    - if any error appear in API gateway and alarm is triggered, then rollback

---

## Implementation status

Every item is implemented. Each PR was branched from `origin/main`.
**Nothing has been deployed to AWS yet.** The first CI deploy is the first end-to-end run.
Usage details are in [README.md](README.md).

### Naming

The REST API keeps the story's name, `api-user-<env>`.
Every other resource is named `rollback-factory-demo-<resource>-<env>` by `resourceName()` in [`lib/config.ts`](lib/config.ts), for example:
- stack `rollback-factory-demo-dev`
- user pool `rollback-factory-demo-users-dev`
- topic `rollback-factory-demo-notifications-dev`

### Requirements

| # | Requirement | Status | PR |
|---|---|---|---|
| 1 | AWS CDK with TypeScript | Done | #1 |
| 2 | API name `api-user-dev` / `api-user-prod` | Done | #1 |
| 3 | 2 endpoints with GET and POST | Done | #1 |
| 4 | Cognito authorizer | Done | #1 |
| 5 | Bruno collection + Cognito token script | Done | #2 |
| 6 | OpenAPI spec stored in S3 | Done (with deviations) | #3, #8 |
| 7 | DynamoDB table recording each deployment | Done | #3 |
| 8 | Integration steps | Done | #4 |
| 9 | 4xx and 5xx alarms with optional SNS notification | Done | #5, #8 |
| 10 | SNS → rollback Lambda (within X minutes, previous spec, stage v1) | Done | #5, #8 |
| 11 | GitHub workflow: deploy, test, promote to prod, rollback | Done | #6, #7, this PR |

#### 1-4. API

- **API:** CDK app in [`lib/api-user-stack.ts`](lib/api-user-stack.ts). `-c env=dev|prod` selects the environment. The stage is `v1`.
- **Endpoints:** `GET`/`POST` on `/users` and `/messages`, served by one Node 24 Lambda.
  - `POST` bodies must be `{ "message": "..." }`; API Gateway's request validator rejects anything else with a 400.
- **Auth:** the native API Gateway **Cognito User Pools authorizer**. It does the same job as a custom Lambda authorizer with nothing extra to maintain. Clients send the Cognito ID token in the `Authorization` header.

#### 5. Bruno collection + token script

- **Collection:** `npm run collection:sync -- --env <env>` synthesizes the stack and writes one Bruno request per API method into [`bruno/`](bruno).
  - It also fills `bruno/environments/<env>.bru` from the stack outputs.
  - Requests for routes that no longer exist are removed; requests you add by hand are kept.
  - It runs before every deploy, both from `npm run deploy:<env>` and in CI.
- **Token:** `npm run token -- --env <env> [--write-env]` prints a Cognito ID token, and can store it in `bruno/.env` for the collection.
- **Test user:** `npm run user:create` creates a confirmed user.
- **Choice:** Bruno only, no Postman.

#### 6. OpenAPI spec in S3

- **How:** after each deploy, `npm run deployment:record` exports stage `v1` as OpenAPI 3 JSON, including the API Gateway extensions, so the spec can be imported again for a rollback.
- **Where:** `s3://rollback-factory-demo-<account>-deployments-<env>/<apiName>/<yyyymmddThhmmssZ>/openapi.json`, e.g. `api-user-dev/20261006T123005Z/openapi.json`
- **Deviation:** one versioned bucket per environment, with the timestamp in the object key. A new bucket per deployment, as the story's name suggests, would hit AWS bucket limits and scatter the history.
- **Deviation:** the spec is stored right *after* the deploy, not before. API Gateway can only export a stage that is already deployed. Every deployment still gets its own spec, which is what rollback needs.

#### 7. Deployment records (DynamoDB)

- **Table:** `rollback-factory-demo-deployments-<env>`, keyed by `apiName` + `deployedAt`.
- **Each record holds:**
  - the API Gateway deployment ID and the spec location
  - `source`: `manual`, `cicd` or `rollback`
  - the actor, commit and CI run link
- **Writers:** the record script (manual and CI deploys) and the rollback Lambda. `npm run deployment:list` shows the history.
- **Verified:** CI sets `verifiedAt` once the integration tests pass (`deployment:verify`). The rollback Lambda only restores verified deployments that were never rolled back; the manual `api-gateway-restore` workflow can restore any recorded deployment.
- **Current / stable:** the record the stage serves has `current=true`. When a new deployment is recorded, the previous one gets `stable=true` and `stableFor` (seconds until the next deployment); an alarm rollback marks the rolled-back deployment `stable=false` and removes `stableFor`.
- **Limitation:** a deployment made outside these paths, such as "Deploy API" in the AWS console, is not recorded.

#### 8. Integration tests

- **Suite:** [`integration/`](integration). `API_ENV=<env> npm run test:integration` runs against the deployed API.
- **Coverage:** `GET` and `POST` on both resources, plus 401 without a token, 401 with an invalid token, and 400 for an invalid body.
- **Test user:** each run creates and deletes a throwaway Cognito user, so CI only needs AWS credentials.

#### 9. Alarms + SNS

- **Alarms:** `rollback-factory-demo-4xx-rate-<env>` and `rollback-factory-demo-5xx-rate-<env>` on stage `v1`.
  - Each fires on the error *rate*: 4xx above 25 %, or 5xx above 5 %, in 2 of 3 one-minute periods.
  - Minutes with too few requests are ignored, so a few intentional 4xx responses (such as the integration tests) can't trigger a rollback.
- **Optional SNS:** alarm actions go to the topic `rollback-factory-demo-notifications-<env>`.
  - `-c alarmNotifications=false` turns the actions off.
  - `-c alarmEmail=...` also subscribes an e-mail address.

#### 10. Rollback Lambda

`rollback-factory-demo-rollback-<env>` is subscribed to the topic and only accepts its own two alarms. On an `ALARM` it acts only if all of these hold:
- the latest deployment is younger than **X = `-c rollbackWindowMinutes`** (default 30)
- that deployment is not itself a rollback
- there is an earlier deployment to go back to
- the errors are not the backend Lambda's fault: its paired alarm (`rollback-factory-demo-lambda-<4xx|5xx>-rate-<env>`, counting only errors of requests that reached the Lambda) is not in `ALARM`, and the Lambda produced less than half of the errors in the last 3 minutes

It then:
1. marks the bad deployment's record, so the 4xx and 5xx alarms together roll back only once
2. downloads the previous deployment's spec from S3
3. re-imports it with `PutRestApi mode=overwrite` and redeploys stage `v1`
4. records the rollback

**API rollback only.** The API invokes the backend through its `live` alias, which `cdk deploy` moves to each new version. The rollback Lambda points a restored spec's integrations at that alias, so a rollback restores the API config and keeps the latest code. A broken Lambda is not rolled back.

**Demo helpers:**
- `-c chaosFailureRate=<0..1>` makes the backend return 500s (the Lambda is at fault, so the rollback is skipped).
- `npm run rollback:trigger -- --env <env>` invokes the rollback Lambda directly, as SNS would.

#### 11. GitHub workflow

Files: [`.github/workflows/api-gateway.yml`](../.github/workflows/api-gateway.yml), which calls [`api-gateway-deploy.yml`](../.github/workflows/api-gateway-deploy.yml) once per environment.

- **Triggers:** pull requests and pushes to `main` that change `aws-api-gateway/**` or the workflows. Changes to `.md` files alone don't trigger a run.
- **Pull requests:** typecheck, unit tests, synth dev and prod, and a check that the Bruno collection is up to date.
- **`main` / manual run:** for dev, then for prod:
  1. bootstrap
  2. Bruno collection sync
  3. `cdk deploy`
  4. record the deployment (spec → S3, record → DynamoDB)
  5. integration tests. **If they fail, the workflow triggers the rollback Lambda** and the job fails.
  6. deployment history in the job summary
- **Promotion:** prod deploys only when dev is green. Add required reviewers on the `prod` GitHub environment to gate it with an approval.
- **Alarm rollback:** happens only in AWS (alarm → SNS → rollback Lambda). The workflow doesn't watch alarms after a deploy.
- **AWS auth:** access-key secrets per GitHub environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, variable `AWS_REGION`).

### Known limitations

- **CloudFormation drift:** after a rollback, the live API differs from what CloudFormation last applied. The next `cdk deploy` only updates the API resources whose template changed.
- **Unrecorded deployments:** deployments made outside the record script and the rollback Lambda (such as console "Deploy API") are not recorded, so the rollback Lambda can't see them.
- **Re-import vs. stage switch:** rollback re-imports the previous spec, as the story asks. A lighter alternative would be to point stage `v1` back at the previous deployment ID.
