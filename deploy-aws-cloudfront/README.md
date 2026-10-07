# frontend-user

Static frontend for `api-user-<env>`, served by CloudFront from a private S3 bucket with versioned
releases and alarm-driven rollback. The story is in [story-implementation.md](story-implementation.md);
the work is split into tickets in [docs/](docs/README.md).

## Stacks

`-c env=dev|prod` selects the environment (default `dev`, or `FRONTEND_ENV`).

| Stack | Region | Holds |
|---|---|---|
| `deploy-aws-cloudfront-<env>` | `CDK_DEFAULT_REGION` (the API's region) | site bucket, distribution `frontend-user-<env>`, deployments bucket + table |
| `deploy-aws-cloudfront-alarms-<env>` | `us-east-1` | the CloudFront 4xx / 5xx alarms |

CloudFront only publishes its metrics in `us-east-1`, so the alarms stack lives there. The rollback itself is done by the
[rollback service](../rollback-service): deploy it to the environment first, since the alarms publish to its us-east-1 topic.
Both regions must be bootstrapped:

```sh
npx cdk bootstrap aws://<account>/<main-region> aws://<account>/us-east-1
```

## Hosting

- **Site bucket** `rollback-factory-demo-<account>-frontend-site-<env>`: private (all public access
  blocked, HTTPS only). Only the two distributions can read it, through Origin Access Control. Retained in prod.
- **Two distributions**, configured the same way: HTTPS only (HTTP redirects), HTTP/2 + HTTP/3,
  managed security headers, `index.html` as root object.

  | Distribution (comment) | Used by | Alarms / rollback |
  |---|---|---|
  | `frontend-user-<env>` | clients | yes |
  | `frontend-user-<env>-integration` | CI: each release is made live and tested here first | no, so test traffic never counts toward a rollback |

- **Releases:** each release lives under `releases/<id>/`, and each distribution's **origin path**
  (`/releases/<id>`) selects the release it serves. Both read the same bucket, so the release that
  passed on integration is exactly what clients get. A fresh stack serves a placeholder from
  `releases/initial/`.
- **`-c liveReleaseId` / `-c integrationReleaseId`:** `cdk deploy` sets each origin path to this
  release, or to `initial` without it. Always pass both (`npm run live:context`), or a deploy undoes an
  activation or a rollback.
- **Dashboard API** at `/api/*` on both distributions: a Lambda (`rollback-factory-demo-frontend-dashboard-api-<env>`,
  [`lambda/dashboard-api`](lambda/dashboard-api)) behind a function URL with IAM auth, which only these two
  distributions can call (Origin Access Control). Never cached. It reads the stack region's
  API Gateways: the API list, each API, and its stages and deployments (`apigateway:GET`, one API id per
  path, so no stage exports). It also lists the region's Lambda functions registered for rollback
  with their aliases and versions (`lambda:ListFunctions`; `ListAliases` and `ListVersionsByFunction` on the
  registered functions only, e.g. `service-lambda-*`) and reads
  their last 24 hours of metrics (`cloudwatch:GetMetricData`). Function configurations come with environment
  variables: the reader copies named fields only, so they never reach the page. It lists the account's CloudFront
  distributions and reads one with its invalidations (`cloudfront:ListDistributions`, `GetDistribution`,
  `ListInvalidations`, `GetInvalidation`; origin custom headers are never sent on), the release history of
  every environment's `frontend-user-<env>` (`dynamodb:Query` on `rollback-factory-demo-frontend-deployments-*`),
  and CloudFront metrics in us-east-1. For each `api-user-<env>` it reads the recorded deployments too
  (`dynamodb:Query` on `rollback-factory-demo-deployments-*`) and the routes of their OpenAPI exports
  (`s3:GetObject` on `rollback-factory-demo-<account>-deployments-*/api-user-*/openapi.json` only; the
  routes are sent on, never the integration details). Its only writes go through the rollback
  service: they invoke `rollback-factory-demo-rollback-service-<env>` (`lambda:InvokeFunction` on those
  functions only):
  - `POST /api/api-gateways/<id>/restore` with `{"deployedAt": "..."}`: the rollback service re-imports
    that deployment's OpenAPI export from S3 and redeploys the stage, like `deployment:restore`.
  - `POST /api/cloudfront-distributions/<id>/restore` with `{"deployedAt": "..."}` (`frontend-user-<env>`
    only): the rollback service points the site origin at that record's release, invalidates `/*` and
    records a `restore`, like `deployment:restore`. A release that is live already is refused.
  - `POST /api/lambda-functions/<name>/point-alias` with `{"aliasName": "...", "version": 3}` (functions
    registered for rollback only): the rollback service points the alias at the version (see the Lambda
    Functions panel below).

  They don't wait: each starts the rollback service asynchronously (it never retries) and answers `202`
  with an operation id, `<env>.<kind>.<start ms>.<random>`. The page opens a popup and polls
  `GET /api/operations/<id>`, which finds the run's lines in the rollback service's log group
  (`rollback-factory-demo-rollback-service-logs-<env>`, `logs:FilterLogEvents` on those only): first the
  line with the operation id, then every line of that request id. It returns them with a status
  (`queued`, `running`, `succeeded`, `skipped`, `failed`), the steps done (from the step lines the
  service logs) and a progress percentage. The popup shows the progress bar, the steps and the live log;
  closing it doesn't stop the run.
  The CloudFront behavior allows POST for it (OAC needs the body's SHA-256 in `x-amz-content-sha256`), and
  waits up to 60 s. It has no sign-in: anyone with the site URL can see the API, function and distribution
  names, stages, versions, releases and settings, **restore an API deployment or a site release, and point
  the aliases of the registered Lambda functions**.
- **Release switches touch the site origin only:** activations, restores and the rollback service
  set the origin path of the S3 origin and leave the function URL origin alone (`releaseOrigins`).
- **No SPA fallback:** missing files are real 403s (S3 answers 403 for missing keys when the reader
  can't list the bucket), so a broken release trips the 4xx alarm.
- **Outputs** (exported as `rollback-factory-demo-frontend-<output>-<env>`, so they never clash with the API stack's exports in the same region): `DistributionId`,
  `DistributionDomainName`, `SiteUrl`, `IntegrationDistributionId`, `IntegrationSiteUrl`, `SiteBucketName`, `DeploymentsBucketName`, `DeploymentsTableName`.
- **TLS:** the default `*.cloudfront.net` certificate is used, so the minimum TLS version can't be
  raised without a custom domain.

## App

Vite + React in [`app/`](app). **One static page** (`index.html`): the AWS Control Center dashboard.
- **API Gateways** is live: the region's REST, HTTP and WebSocket APIs with their stages and latest
  deployment, from `GET /api/api-gateways` (the dashboard API). Search filters the list, refresh reloads it
  (and the selected API). Next to it, the selected API's **deployments**, its **stages** (and the deployment
  each serves) and its **configuration**, from `GET /api/api-gateways/<id>?type=<REST|HTTP|WEBSOCKET>`. For
  `api-user-<env>` the deployments are the ones recorded in DynamoDB (marked live, verified or rolled back),
  each with a **Restore** button (after a confirm; the live one can't be restored); for other APIs they are
  API Gateway's own, with nothing to restore. On the **Stages** tab, the stage these deployments are
  recorded for (`v1`) has a **Rollback** menu listing them newest first, with their source, commit, Lambda
  version and whether they were verified or rolled back; the previous verified one is marked. Before a
  rollback or restore, the confirm lists the routes it removes and brings back, from both deployments'
  OpenAPI exports in S3 (`GET /api/api-gateways/<id>/spec?deployedAt=...`). Either goes through the
  same restore. Other stages (`integration`, redeployed by CI) and other APIs can't be rolled back here.
- **Lambda Functions** is live too, for the functions registered for rollback only
  (`rollback-service/rollback-config.json`, passed to the dashboard API as `REGISTERED_FUNCTIONS` at deploy
  time): their runtime, aliases and last change, from `GET /api/lambda-functions`. Next to it, the selected
  function's published **versions** (and the aliases serving each), its **aliases** (with weights), its
  **configuration**, and **monitoring**: invocations, errors, throttles, durations and concurrency over 24
  hours, fetched only when that tab opens. Each alias has a **Point to version** menu and each version a
  **Point alias** menu, after a confirm: `POST /api/lambda-functions/<name>/point-alias` with
  `{"aliasName": "...", "version": 3}`, carried out by that environment's rollback service. Moving the
  watched alias (`live`) restores `$LATEST` from the version's archived package too; going back is a manual
  rollback (cooldown, the version left is marked rolled back from), going forward a promotion. Any other
  alias (`integration`) just moves. Other functions are neither listed nor read (404).
- **CloudFront Distributions** is live as well: every distribution with its status and, for this project's
  sites, the release it serves, from `GET /api/cloudfront-distributions`. Next to it, the selected one's
  **deployments** (the activations, restores and rollbacks recorded for `frontend-user-<env>`, marked live,
  verified or rolled back), its **configuration**, its latest **invalidations** and **monitoring** (requests,
  data transferred, 4xx and 5xx rates over 24 hours); the last two load only when their tab opens.
  Each recorded release has a **Restore** button (after a confirm; the live release can't be restored). It
  counts as verified once the integration tests pass again; CloudFront takes a few minutes to deploy it.

The page also shows which environment and release it is:
- the name (`frontend-user-<env>`), the environment and the release id in the sidebar, the build time as "Last updated"
- the release id again in the footer, so an activation or a rollback is visible

**Sign-in and the API page are out of scope for now.** The earlier version signed in with the API's
Cognito user pool and called `GET`/`POST` on `/users` and `/messages`. It's in git history
(PR #23) for when they come back.

- **Config:** read at build time from `VITE_ENV`, `VITE_RELEASE_ID` and `VITE_BUILT_AT`
  (`release:build` sets them). Without them the page shows `local`.
- **No API dependency:** the frontend doesn't need the api-user stack to build or deploy; the
  dashboard lists whatever APIs the region has.

Local run (`/api` only works with `DASHBOARD_API_URL` set to a deployed site, which it is proxied to):

```sh
DASHBOARD_API_URL=https://dxxxxxxxxxxxxx.cloudfront.net npm run app:dev
```

## Releases

A release is one build of the app for one environment, identified by its UTC build time
(`20261006T123005Z`). Releases are never overwritten, so any older one can be switched back to.

1. **`release:build`** builds the app into `dist/` with the environment, release id and build time,
   and writes `release.json`.
2. **`release:upload`**:
   - uploads `dist/` to `s3://<site bucket>/releases/<id>/`. HTML gets `Cache-Control: no-cache`,
     the hashed assets are cached for a year.
   - stores the **build manifest** (release id, commit, actor, CI run, API settings, and every file
     with size, sha256, content type) at
     `s3://rollback-factory-demo-<account>-frontend-deployments-<env>/frontend-user-<env>/<id>/manifest.json`.
   - fails if the release prefix already exists.
3. **`release:activate`**:
   - checks every manifest file is in the bucket
   - points the distribution's origin path at `/releases/<id>`, conditional on the ETag so a
     concurrent change isn't overwritten
   - invalidates `/*`
   - `--wait` waits for both and prints how long they took. The result is printed as JSON
     (`previousReleaseId`, `invalidationId`, ...).

The origin-path switch lives in [`lambda/shared/releases.ts`](lambda/shared/releases.ts), so the
rollback service uses the same switch (a copy of it).

**Deviation:** the story's bucket name (`frontendname-awsaccount-deployments-datetimestamp`) suggests one
bucket per deployment. As for the API, it is one versioned bucket per environment with the release id in
the key, which avoids bucket limits and keeps the history in one place.

## Deployment records

Every time the distribution starts serving a release, a record goes into
`rollback-factory-demo-frontend-deployments-<env>`, keyed by `frontendName` + `deployedAt`. It
follows the API's record model, so both histories read the same way.

- **Each record holds:** `releaseId`, origin path, distribution, manifest key, invalidation id,
  the previous release, `source` (`manual`, `cicd`, `rollback` or `restore`), actor, the commit
  the release was built from, and the CI run link.
- **Writers:** `deployment:record` (after `release:activate`, manual or CI), `deployment:restore`,
  and the rollback service. `deploy:<env>` records automatically.
- **Current / stable:** the record the distribution serves has `current=true`. When a new one is
  recorded, the previous one gets `stable=true` plus `stableFor` (seconds until the next deployment)
  and `stableForHumanReadable`. A deployment an alarm rolled back is `stable=false`.
- **Verified:** `deployment:verify` sets `verifiedAt` once the integration tests pass. The rollback
  Lambda only goes back to verified deployments. A restore isn't verified until the tests pass again.
- **Checks:** `deployment:record` and `deployment:verify` check what the distribution really serves,
  so a record never describes a release that isn't live.
- **Limitation:** changing the origin path in the CloudFront console is not recorded.

## Alarms

In `deploy-aws-cloudfront-alarms-<env>` (us-east-1, where CloudFront publishes its metrics):

- **Alarms:** `rollback-factory-demo-cloudfront-frontend-user-4xx-rate-<env>` and
  `rollback-factory-demo-cloudfront-frontend-user-5xx-rate-<env>` on the distribution's `4xxErrorRate` /
  `5xxErrorRate` (`AWS/CloudFront`, `Region=Global`). The `cloudfront` in the name tells the rollback
  service which manager handles them.
  - 4xx above 25 %, or 5xx above 5 %, in 2 of 3 one-minute periods.
  - Minutes with fewer than 20 (4xx) / 5 (5xx) requests count as 0, so the smoke test's one
    intentional 404 can't fire them.
- **Topic:** they publish to the rollback service's us-east-1 topic,
  `rollback-factory-demo-rollback-notifications-<env>`. `-c alarmNotifications=false` turns the actions
  off (the alarms still change state). An e-mail subscription is set on the rollback service
  (`-c alarmEmail=...` there).
- **Distribution id:** passed from the main stack as a cross-region reference (CDK writes it to SSM
  in us-east-1). Strong references are set explicitly in `cdk.json`, so the main stack can't drop
  the distribution while the alarms use it.
- **Delay:** CloudFront metrics arrive a few minutes late, so expect an alarm roughly 3–6 minutes
  after the errors start.

## Rollback

Done by the [rollback service](../rollback-service)'s **CloudFront manager**
(`rollback-factory-demo-rollback-service-<env>`, in the main region). It reads what it needs from
this stack's `RollbackTarget` output: the distribution clients use (never the integration one), the
deployments table, the alarm names and the window.

**When it acts.** On an `ALARM`, it rolls back only if all of these hold:
- the latest deployment is younger than **X = `-c rollbackWindowMinutes`** (default 30)
- that deployment is not itself a rollback or a restore, and wasn't already rolled back
- the distribution really serves the latest recorded release (no unrecorded console change)
- a target exists: the newest earlier deployment of **another release** that is **verified** and
  whose release was never rolled back

**What it does:**
1. marks the bad deployment `rolledBackAt` with a conditional write, so the 4xx and 5xx alarms
   together roll back only once
2. switches the origin path to the target release and invalidates `/*` (the same switch as `release:activate`)
3. records a `rollback` deployment. It inherits the target's `verifiedAt`, since it is the same
   release. The bad deployment is retired as `stable=false`.

It doesn't wait for the distribution to deploy, which takes a few minutes.

**Demo:** `npm run rollback:trigger -- --env dev` invokes the rollback service with a fake alarm,
exactly as SNS would.

## GitHub workflows

Files: [`frontend.yml`](../.github/workflows/frontend.yml), which calls
[`frontend-deploy.yml`](../.github/workflows/frontend-deploy.yml) once per environment, and
[`frontend-restore.yml`](../.github/workflows/frontend-restore.yml).

- **Triggers:** pull requests and pushes to `main` that change `deploy-aws-cloudfront/**` or
  these workflows. Changes to `.md` files alone don't trigger a run.
- **Pull requests:** typecheck, unit tests, app build with dummy settings, synth dev and prod.
  No AWS credentials are needed.
- **`main` / manual run:** for each environment in turn (dev → testing → staging → prod):
  1. bootstrap the main region and us-east-1
  2. `cdk deploy --all`, both distributions keeping their release (`live:context`)
  3. `release:build`, then `release:upload` (release + manifest)
  4. `release:activate --target integration --wait`: the release goes live on
     `frontend-user-<env>-integration` only
  5. integration tests there (`FRONTEND_TARGET=integration`, `FRONTEND_RELEASE` = the new release)
  6. `release:activate --wait`: the same release goes live on `frontend-user-<env>`, then
     `deployment:record` and `deployment:verify`
  7. activation timing (distribution deployed / invalidation completed) and the deployment
     history in the job summary
- **Failed tests:** the job stops with the test output in the summary. `frontend-user-<env>` was never
  touched, and the next environments aren't deployed. This is the same as the API's integration stage.
- **Promotion:** each environment deploys only when the previous one is green, and gets its own build.
  Add required reviewers on the `prod` GitHub environment to gate it with an approval.
- **Alarm rollback:** happens only in AWS (alarm → SNS → rollback service). The workflow doesn't
  watch alarms after a deploy.
- **Restore:** `frontend-restore` (manual) restores a release you choose, runs the integration
  tests against it and marks it verified if they pass.
- **AWS auth:** access-key secrets per GitHub environment (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, variable `AWS_REGION`), the same as the API.

## Demo: break the frontend

[`break-frontend-demo.yml`](../.github/workflows/break-frontend-demo.yml) is a manual workflow that
runs in dev only.

1. **Preflight:** checks that dev has a verified release to roll back to (deploy `main` through CI
   first).
2. **Broken release:** builds a release and uploads it with `--break missing-assets`, which uploads
   the HTML but none of `assets/`. It is activated and recorded but not tested, so it is never
   verified. Every page then loads, but its scripts and styles answer 403.
3. **Traffic:** `demo:traffic` loads both pages and everything they reference, as a browser would,
   for `traffic_minutes` (default 12). Every 30 s it logs the status codes, the 4xx share and the
   release the distribution points at.

The workflow never rolls back. The 4xx alarm should fire after about 3–6 minutes, and the rollback
Lambda switches dev back. The traffic log shows the origin path switching, and later the 403s
stopping once the invalidation is done. The job summary says which release dev serves at the end,
next to the deployment history with the `rollback` record.

To demo without breaking anything, `npm run rollback:trigger -- --env dev` sends the Lambda a fake
alarm. It only rolls back if the latest deployment is within the rollback window.

## Integration tests

`FRONTEND_ENV=<env> npm run test:integration` tests the release `frontend-user-<env>` serves.
- **`FRONTEND_TARGET=integration`** tests `frontend-user-<env>-integration` instead, which is what CI
  does before promoting.
- **`FRONTEND_RELEASE=<id>`** makes the run fail unless that release is the one served.

- **Smoke** ([`integration/smoke.integration.test.ts`](integration/smoke.integration.test.ts)):
  - `/` is the live release's `index.html` (sha256 against the manifest) over HTTPS, and HTTP redirects
  - every manifest file loads through CloudFront with its sha256, content type and `Cache-Control`
  - an unknown path is a 403/404, not `index.html`
  - a direct S3 request is refused
- **End to end** ([`integration/e2e.integration.test.ts`](integration/e2e.integration.test.ts),
  headless Chromium with Playwright):
  - the page loads with its scripts and styles
  - it shows the environment and the release the distribution serves
  - any console error, failed request or HTTP error fails the test
- **Needs:**
  - AWS credentials that can read the stack, the distributions and the deployments bucket
  - Chromium for Playwright: `npx playwright install chromium`; in CI, `--with-deps`
- **4xx alarm:** a run makes one intentional 4xx through CloudFront (the unknown path). On the
  integration distribution it can't count toward anything, since that distribution has no alarms.
  The app has a favicon, so browsers don't add a 403 for `/favicon.ico` on every page view.

## Diagram

[`docs/architecture-diagram-prompt.md`](docs/architecture-diagram-prompt.md) has a prompt for an image
model to draw this setup: the two distributions, the release bucket, the deploy flow and the
rollback in us-east-1.

## Scripts

| Command | Does |
|---|---|
| `npm run build` | typecheck (CDK app and frontend app) |
| `npm test` | unit tests |
| `FRONTEND_ENV=<env> npm run test:integration` | smoke + end-to-end tests against the deployed site |
| `npm run synth:dev` / `synth:prod` | synthesize both stacks |
| `npm run app:dev` | run the app locally (reads `app/.env.local`) |
| `npm run app:build` | build the app into `dist/` (reads `VITE_*` from the environment or `app/.env.local`) |
| `npm run deploy:dev` / `deploy:prod` | manual deploy without tests: live context → `cdk deploy --all` → build → upload → activate on `frontend-user-<env>` (waits) → record |
| `npm run release:build -- --env <env>` | build a new release |
| `npm run release:upload -- --env <env>` | upload it + store its manifest |
| `npm run release:activate -- --env <env> --release <id> [--target live\|integration] [--wait]` | make a release live on `frontend-user-<env>` (default) or on the integration distribution |
| `npm run live:context -- --env <env>` | print `-c liveReleaseId=<id> -c integrationReleaseId=<id>` for `cdk deploy` |
| `npm run deployment:record -- --env <env> [--release <id>]` | record the release the distribution serves |
| `npm run deployment:verify -- --env <env> [--release <id>]` | mark the live deployment verified (after the integration tests) |
| `npm run deployment:list -- --env <env> [--limit 10]` | deployment history |
| `npm run deployment:restore -- --env <env> --release <id> [--wait]` | activate any release with a manifest and record a `restore` |
| `npm run rollback:trigger -- --env <env> [--alarm 4xx\|5xx]` | invoke the rollback service as SNS would (demo) |
| `npm run demo:traffic -- --env <env> [--minutes 10] [--preflight]` | load the site like a browser and report status codes + the live release (demo) |

## Context options

| Option | Default | Used by |
|---|---|---|
| `liveReleaseId` | – | origin path `frontend-user-<env>` keeps (FE-02, FE-04) |
| `integrationReleaseId` | – | origin path `frontend-user-<env>-integration` keeps (FE-11) |
| `alarmNotifications` | `true` | alarm actions on/off (FE-07) |
| `rollbackWindowMinutes` | `30` | rollback window, published in `RollbackTarget` |
