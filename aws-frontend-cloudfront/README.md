# frontend-user

Static frontend for `api-user-<env>`, served by CloudFront from a private S3 bucket with versioned
releases and alarm-driven rollback. The story is in [story-implementation.md](story-implementation.md);
the work is split into tickets in [docs/](docs/README.md).

## Stacks

`-c env=dev|prod` selects the environment (default `dev`, or `FRONTEND_ENV`).

| Stack | Region | Holds |
|---|---|---|
| `rollback-factory-demo-frontend-<env>` | `CDK_DEFAULT_REGION` (the API's region) | site bucket, distribution `frontend-user-<env>`, deployments bucket + table |
| `rollback-factory-demo-frontend-alarms-<env>` | `us-east-1` | CloudFront alarms, SNS topic, rollback Lambda |

CloudFront only publishes its metrics in `us-east-1`, so the alarms stack lives there.
Both regions must be bootstrapped:

```sh
npx cdk bootstrap aws://<account>/<main-region> aws://<account>/us-east-1
```

## Hosting

- **Site bucket** `rollback-factory-demo-<account>-frontend-site-<env>`: private (all public access
  blocked, HTTPS only). Only the distribution can read it, through Origin Access Control. Retained in prod.
- **Distribution** `frontend-user-<env>` (its comment): HTTPS only (HTTP redirects), HTTP/2 + HTTP/3,
  managed security headers, `index.html` as root object.
- **Releases:** each release lives under `releases/<id>/`, and the distribution's **origin path**
  (`/releases/<id>`) selects the live one. A fresh stack serves a placeholder from `releases/initial/`.
- **`-c liveReleaseId`:** `cdk deploy` sets the origin path to this release, or to `initial` without it.
  Always pass the live release (`npm run live:context`, FE-04), or a deploy undoes an activation or a rollback.
- **No SPA fallback:** missing files are real 403s (S3 answers 403 for missing keys when the reader
  can't list the bucket), so a broken release trips the 4xx alarm.
- **Outputs** (exported as `rollback-factory-demo-frontend-<output>-<env>`, so they never clash with the API stack's exports in the same region): `DistributionId`,
  `DistributionDomainName`, `SiteUrl`, `SiteBucketName`, `DeploymentsBucketName`, `DeploymentsTableName`.
- **TLS:** the default `*.cloudfront.net` certificate is used, so the minimum TLS version can't be
  raised without a custom domain.

## App

Vite + plain TypeScript in [`app/`](app), no framework and no Amplify.

- **`index.html`:** sign-in with the API's Cognito user pool (`USER_PASSWORD_AUTH`), including the
  "set a new password" step for users an admin created.
- **`app.html`:** `GET` and `POST` on `/users` and `/messages` of `api-user-<env>`, with the status
  code and body of each response. It sends the raw ID token in `Authorization` (what the API's Cognito
  authorizer expects) and refreshes it shortly before it expires.
- **Footer:** shows the release id, so an activation or a rollback is visible.
- **Session:** tokens are kept in `sessionStorage` (per tab, gone when the tab closes). Fine for a demo;
  a production app would use the Hosted UI with PKCE and keep the refresh token out of JavaScript.
  Sign out only forgets the tokens locally.
- **Config:** read at build time from `VITE_API_URL`, `VITE_USER_POOL_ID`, `VITE_USER_POOL_CLIENT_ID`,
  `VITE_REGION` (the `ApiUrl`, `UserPoolId` and `UserPoolClientId` outputs of `rollback-factory-demo-<env>`)
  and `VITE_RELEASE_ID`. A build without the first four fails.

Local run against the dev API (create a user with `npm run user:create` in `aws-api-gateway`):

```sh
cp app/.env.example app/.env.local   # fill in the dev stack outputs
npm run app:dev
```

## Releases

A release is one build of the app for one environment, identified by its UTC build time
(`20261006T123005Z`). Releases are never overwritten, so any older one can be switched back to.

1. **`release:build`** reads `ApiUrl`, `UserPoolId` and `UserPoolClientId` from
   `rollback-factory-demo-<env>`, builds the app into `dist/` and writes `release.json`.
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
rollback Lambda uses the same code.

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
  and the rollback Lambda (FE-08). `deploy:<env>` records automatically.
- **Current / stable:** the record the distribution serves has `current=true`. When a new one is
  recorded, the previous one gets `stable=true` plus `stableFor` (seconds until the next deployment)
  and `stableForHumanReadable`. A deployment an alarm rolled back is `stable=false`.
- **Verified:** `deployment:verify` sets `verifiedAt` once the integration tests pass. The rollback
  Lambda only goes back to verified deployments. A restore isn't verified until the tests pass again.
- **Checks:** `deployment:record` and `deployment:verify` check what the distribution really serves,
  so a record never describes a release that isn't live.
- **Limitation:** changing the origin path in the CloudFront console is not recorded.

## Alarms

In `rollback-factory-demo-frontend-alarms-<env>` (us-east-1, where CloudFront publishes its metrics):

- **Alarms:** `rollback-factory-demo-frontend-4xx-rate-<env>` and `rollback-factory-demo-frontend-5xx-rate-<env>`
  on the distribution's `4xxErrorRate` / `5xxErrorRate` (`AWS/CloudFront`, `Region=Global`).
  - 4xx above 25 %, or 5xx above 5 %, in 2 of 3 one-minute periods.
  - Minutes with fewer than 20 (4xx) / 5 (5xx) requests count as 0, so the smoke test's one
    intentional 404 can't fire them.
- **SNS topic:** `rollback-factory-demo-frontend-notifications-<env>` receives the alarm actions.
  - HTTPS only. CloudWatch may publish, but only for these two alarms in this account; without
    that explicit allow, the topic's TLS-only policy would block the alarm actions.
  - `-c alarmNotifications=false` turns the actions off (the alarms still change state).
  - `-c alarmEmail=...` subscribes an e-mail address.
- **Distribution id:** passed from the main stack as a cross-region reference (CDK writes it to SSM
  in us-east-1). Strong references are set explicitly in `cdk.json`, so the main stack can't drop
  the distribution while the alarms use it.
- **Delay:** CloudFront metrics arrive a few minutes late, so expect an alarm roughly 3–6 minutes
  after the errors start.

## Rollback Lambda

`rollback-factory-demo-frontend-rollback-<env>` lives in us-east-1, next to the alarms. It is
subscribed to the topic and only accepts its own two alarms.

**When it acts.** On an `ALARM`, it rolls back only if all of these hold:
- the latest deployment is younger than **X = `-c rollbackWindowMinutes`** (default 30)
- that deployment is not itself a rollback or a restore, and wasn't already rolled back
- the distribution really serves the latest recorded release (no unrecorded console change)
- a target exists: the newest earlier deployment of **another release** that is **verified** and
  whose release was never rolled back

**What it does:**
1. marks the bad deployment `rolledBackAt` with a conditional write, so the 4xx and 5xx alarms
   together roll back only once
2. switches the origin path to the target release and invalidates `/*` (the same code as `release:activate`)
3. records a `rollback` deployment. It inherits the target's `verifiedAt`, since it is the same
   release. The bad deployment is retired as `stable=false`.

**What it doesn't do.** It doesn't wait for the distribution to deploy, which takes a few minutes,
so its timeout is 30 s. The decision (rolled back, or skipped and why) is logged as JSON.

**Access.**
- **Deployments table:** the table is in the main region, and the Lambda writes to it by its fixed
  name with a client for that region.
- **IAM:** it may only read, update and invalidate this distribution, and read and write this table.

**Demo:** `npm run rollback:trigger -- --env dev` invokes it with a fake alarm, exactly as SNS would.

## GitHub workflows

Files: [`frontend.yml`](../.github/workflows/frontend.yml), which calls
[`frontend-deploy.yml`](../.github/workflows/frontend-deploy.yml) once per environment, and
[`frontend-restore.yml`](../.github/workflows/frontend-restore.yml).

- **Triggers:** pull requests and pushes to `main` that change `aws-frontend-cloudfront/**` or
  these workflows. Changes to `.md` files alone don't trigger a run.
- **Pull requests:** typecheck, unit tests, app build with dummy settings, synth dev and prod.
  No AWS credentials are needed.
- **`main` / manual run:** for dev, then for prod:
  1. bootstrap the main region and us-east-1
  2. `cdk deploy --all`, keeping the live release (`live:context`)
  3. `release:build` against that environment's api-user stack, then `release:upload` (release + manifest)
  4. `release:activate --wait`, then `deployment:record`
  5. integration tests, with `FRONTEND_RELEASE` set to the new release
  6. `deployment:verify`
  7. activation timing (distribution deployed / invalidation completed) and the deployment
     history in the job summary
- **Failed tests:** the environment is switched back to the release it served before
  (`deployment:restore`, recorded as a `restore`). The job fails with the test output in the summary,
  and prod isn't deployed. A release can only be tested once it is live, because the bucket is
  private and the distribution has one origin path, so the switch back is the workflow's safety net.
  On the very first deploy there is nothing to switch back to.
- **Promotion:** prod deploys only when dev is green. Prod gets its own build, with the prod API
  and user pool. Add required reviewers on the `prod` GitHub environment to gate it with an approval.
- **Alarm rollback:** happens only in AWS (alarm → SNS → rollback Lambda). The workflow doesn't
  watch alarms after a deploy.
- **Restore:** `frontend-restore` (manual) restores a release you choose, runs the integration
  tests against it and marks it verified if they pass.
- **AWS auth:** access-key secrets per GitHub environment (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, variable `AWS_REGION`), the same as the API. The api-user stack must
  already exist in the environment.

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

`FRONTEND_ENV=<env> npm run test:integration` tests the release the distribution serves. Set
`FRONTEND_RELEASE=<id>` to fail unless that release is live, which is what CI does right after
activating one.

- **Smoke** ([`integration/smoke.integration.test.ts`](integration/smoke.integration.test.ts)):
  - `/` is the live release's `index.html` (sha256 against the manifest) over HTTPS, and HTTP redirects
  - every manifest file loads through CloudFront with its sha256, content type and `Cache-Control`
  - an unknown path is a 403/404, not `index.html`
  - a direct S3 request is refused
- **End to end** ([`integration/e2e.integration.test.ts`](integration/e2e.integration.test.ts),
  headless Chromium with Playwright):
  - creates a throw-away user in the API's user pool, and deletes it afterwards
  - `app.html` without a session redirects to the login page, and the footer shows the live release
  - signs in, then `GET` and `POST` on `/users` and `/messages` through the page, then signs out
  - any console error, failed request or HTTP error fails the step it happened in
- **Needs:**
  - AWS credentials that can read both stacks, the distribution and the deployments bucket, and
    administer the user pool
  - Chromium for Playwright: `npx playwright install chromium`; in CI, `--with-deps`
- **4xx alarm:** a run makes one intentional 4xx through CloudFront (the unknown path). The app has
  a favicon, so browsers don't add a 403 for `/favicon.ico` on every page view.

## Scripts

| Command | Does |
|---|---|
| `npm run build` | typecheck (CDK app and frontend app) |
| `npm test` | unit tests |
| `FRONTEND_ENV=<env> npm run test:integration` | smoke + end-to-end tests against the deployed site |
| `npm run synth:dev` / `synth:prod` | synthesize both stacks |
| `npm run app:dev` | run the app locally (reads `app/.env.local`) |
| `npm run app:build` | build the app into `dist/` (reads `VITE_*` from the environment or `app/.env.local`) |
| `npm run deploy:dev` / `deploy:prod` | live context → `cdk deploy --all` → build → upload → activate (waits) |
| `npm run release:build -- --env <env>` | build a new release against the API stack outputs |
| `npm run release:upload -- --env <env>` | upload it + store its manifest |
| `npm run release:activate -- --env <env> --release <id> [--wait]` | make a release live |
| `npm run live:context -- --env <env>` | print `-c liveReleaseId=<id>` for `cdk deploy` |
| `npm run deployment:record -- --env <env> [--release <id>]` | record the release the distribution serves |
| `npm run deployment:verify -- --env <env> [--release <id>]` | mark the live deployment verified (after the integration tests) |
| `npm run deployment:list -- --env <env> [--limit 10]` | deployment history |
| `npm run deployment:restore -- --env <env> --release <id> [--wait]` | activate any release with a manifest and record a `restore` |
| `npm run rollback:trigger -- --env <env> [--alarm 4xx\|5xx]` | invoke the rollback Lambda as SNS would (demo) |
| `npm run demo:traffic -- --env <env> [--minutes 10] [--preflight]` | load the site like a browser and report status codes + the live release (demo) |

## Context options

| Option | Default | Used by |
|---|---|---|
| `liveReleaseId` | – | origin path the distribution keeps (FE-02, FE-04) |
| `alarmNotifications` | `true` | alarm actions on/off (FE-07) |
| `alarmEmail` | – | e-mail subscription on the alarm topic (FE-07) |
| `rollbackWindowMinutes` | `30` | rollback Lambda window (FE-08) |
