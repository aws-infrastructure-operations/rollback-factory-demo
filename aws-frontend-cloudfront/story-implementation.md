## For each feature create a new branch from origin main and raise a PR or let me raise it

1. Build a static frontend served by CloudFront with versioned releases
 - we need to use AWS CDK with typescript here
 - frontend name should be frontend-user-dev/prod
 - frontend should be simple: a login page and one page that calls the `api-user-<env>` GET and POST endpoints (users and messages)
 - frontend should use the same cognito user pool as the API to sign in and send the ID token to the API
 - the site is hosted in a private S3 bucket, served only through CloudFront (Origin Access Control), HTTPS only
 - each build is uploaded to its own prefix (`releases/<yyyymmddThhmmssZ>/`) and CloudFront points to the active release with the origin path, so older releases stay available for rollback
 - before deploying the frontend,
    - build the app with the API URL and cognito settings for the environment (taken from the api stack outputs)
    - store the build manifest (release id, commit, file list + hashes) into a s3 bucket with the name (frontendname-awsaccount-deployments-datetimestamp)
 - add a dynamodb table to record each deployment made (manually or automatic via CICD)
 - add integration steps for the frontend (smoke test the CloudFront URL, check the assets load and the login + API calls work end to end)
 - for the CloudFront distribution create an ALARM for 4xx and one for 5xx error rate and which has as option to send an sns notification
 - sns notification should invoke a lambda which can perform rollback on the CloudFront distribution assuming something is wrong and if a deployment was made in the past X minutes. Will look at the previous release and switch the origin path back to it, then invalidate the cache
  - we should have a github workflow to
    - deploy the frontend with everything I've said earlier (record, store manifest)
    - run integration testing
    - move to prod frontend if everything is green
    - if any error appear in CloudFront and alarm is triggered, then rollback

---

## Implementation status

Every item is implemented, in tickets FE-01 to FE-10 ([docs/](docs/README.md)), each branched from `origin/main`.
**Nothing has been deployed to AWS yet.** The first CI run on `main` is the first end-to-end run.
Usage details are in [README.md](README.md).

### Naming

The distribution keeps the story's name, `frontend-user-<env>` (its comment and `Name` tag).
Every other resource is named `rollback-factory-demo-<resource>-<env>` by `resourceName()` in
[`lib/config.ts`](lib/config.ts), for example:
- stacks `rollback-factory-demo-frontend-<env>` (main region) and `rollback-factory-demo-frontend-alarms-<env>` (us-east-1)
- table `rollback-factory-demo-frontend-deployments-<env>`
- topic `rollback-factory-demo-frontend-notifications-<env>`

### Requirements

| # | Requirement | Status | PR |
|---|---|---|---|
| 1 | AWS CDK with TypeScript | Done | #21 |
| 2 | Frontend name `frontend-user-dev` / `frontend-user-prod` | Done | #21, #22 |
| 3 | Login page + page calling the API GET and POST endpoints | Out of scope for now (built in #23, replaced by a simple page in FE-12) | #23 |
| 4 | Cognito sign-in using the API's user pool | Out of scope for now (built in #23, removed in FE-12) | #23 |
| 5 | Private S3 bucket behind CloudFront (OAC, HTTPS only) | Done | #22 |
| 6 | Versioned releases selected by origin path | Done | #22, #24 |
| 7 | Build manifest stored in S3 | Done (with a deviation) | #24 |
| 8 | DynamoDB table recording each deployment | Done | #25 |
| 9 | Integration steps | Done | #26 |
| 10 | 4xx and 5xx alarms with optional SNS notification | Done | #27 |
| 11 | SNS → rollback Lambda (within X minutes, previous release, invalidate) | Done | #28 |
| 12 | GitHub workflow: deploy, test, promote to prod, rollback | Done | #29, #31 (demo), FE-11 (integration distribution) |

#### 1-2. CDK app and naming

- **Stacks:** CDK app in [`lib/`](lib); `-c env=dev|prod` selects the environment. Each environment
  has two stacks: CloudFront only publishes its metrics in us-east-1, so the alarms, their topic and
  the rollback Lambda live there, and get the distribution id through a cross-region reference.

#### 3-4. App

- **Stack:** Vite + plain TypeScript in [`app/`](app), no framework and no Amplify.
- **Now (FE-12):** one static page showing the environment, the release id and the build time, so
  an activation or a rollback is visible. Sign-in and the API page are out of scope for now, so the
  frontend no longer depends on the api-user stack.
- **Before (#23, in git history):** a login page against the API's user pool (`USER_PASSWORD_AUTH`,
  including the first-sign-in "new password" step) and an API page with `GET`/`POST` on `/users`
  and `/messages`, sending the raw ID token in `Authorization`.

#### 5-6. Hosting and releases

- **Bucket:** private, HTTPS only, read by the distribution through Origin Access Control.
- **Distribution:** HTTP redirects to HTTPS, and a missing file stays a real 403, so a broken
  release trips the 4xx alarm.
- **Releases:** each build goes to `releases/<yyyymmddThhmmssZ>/` and is never overwritten. The
  origin path selects the live one. `release:activate` checks the files against the manifest,
  switches the origin path (conditional on the ETag) and invalidates `/*`.
- **Integration distribution:** `frontend-user-<env>-integration` reads the same bucket and has no
  alarms. CI makes each release live there first and tests it, like the API's `integration` stage.
- **Keeping the live releases:** `cdk deploy` always gets `-c liveReleaseId=<id> -c integrationReleaseId=<id>`
  (`live:context`), so a deploy never undoes an activation or a rollback.

#### 7. Build manifest

- **Contents:** release id, commit, actor, CI run, the API settings it was built with, and every file
  with size, sha256, content type and cache policy.
- **Where:** `s3://rollback-factory-demo-<account>-frontend-deployments-<env>/frontend-user-<env>/<id>/manifest.json`
- **Deviation:** one versioned bucket per environment, with the release id in the key. A new bucket
  per deployment, as the story's name suggests, would hit bucket limits and scatter the history (the
  same choice as the API).

#### 8. Deployment records (DynamoDB)

- **Table:** keyed by `frontendName` + `deployedAt`. The record model is the API's.
- **Sources:** `manual`, `cicd`, `rollback`, `restore`.
- **Fields:** `current`, `stable` / `stableFor` / `stableForHumanReadable`, `verifiedAt`, `rolledBackAt`.
- **Checks:** `deployment:record` and `deployment:verify` check what the distribution really serves.

#### 9. Integration tests

- **Smoke:** the live release byte for byte (sha256 vs. manifest) with the right headers, HTTP →
  HTTPS, a 4xx for unknown paths, and a private bucket.
- **End to end:** headless Chromium loads the page with its scripts and styles and checks it shows
  the environment and the release served. Any console error or failed request fails the test.

#### 10. Alarms + SNS

- **Alarms:** `rollback-factory-demo-frontend-4xx-rate-<env>` / `-5xx-rate-<env>` on the
  distribution's error rates, 25 % / 5 % in 2 of 3 minutes, ignoring minutes with too few requests.
- **SNS:** the topic is TLS only, with the explicit CloudWatch allow. `-c alarmNotifications=false`
  turns the actions off, and `-c alarmEmail=...` subscribes an address.

#### 11. Rollback Lambda

`rollback-factory-demo-frontend-rollback-<env>` (us-east-1) only accepts its own two alarms.

**When it acts:**
- the latest deployment is younger than **X = `-c rollbackWindowMinutes`** (default 30)
- it is not a rollback or restore
- the distribution serves it
- an earlier verified release that was never rolled back exists

**What it does:** claims the bad deployment (one rollback for both alarms), switches the origin path
back, invalidates `/*`, and records a `rollback`.

**Demo:** `npm run rollback:trigger` invokes it as SNS would.

#### 12. GitHub workflows

- **[`frontend.yml`](../.github/workflows/frontend.yml):** PR checks. On `main`, dev then prod through
  [`frontend-deploy.yml`](../.github/workflows/frontend-deploy.yml): cdk deploy (live release kept),
  build against the env's API, upload + manifest, make it live on the integration distribution,
  integration tests there, make the same release live on `frontend-user-<env>` (timed), record, verify.
- **Failed tests:** the job stops, `frontend-user-<env>` was never touched, and the next environments
  aren't deployed.
- **Alarm rollback:** happens only in AWS (alarm → SNS → rollback Lambda).
- **[`frontend-restore.yml`](../.github/workflows/frontend-restore.yml):** restores a chosen release,
  tests it and marks it verified.
- **[`break-frontend-demo.yml`](../.github/workflows/break-frontend-demo.yml):** activates a release
  without its assets in dev and sends traffic until the alarm rolls it back.

### Known limitations

- **CloudFormation drift:** after an activation or rollback, the origin path differs from what
  CloudFormation last applied. Every deploy passes the live release (`live:context`), so it is never
  reset. A `cdk deploy` without it would go back to the placeholder.
- **Unrecorded changes:** changing the origin path in the console is not recorded. The rollback
  Lambda then refuses to act, because the live release isn't the latest record.
- **Two switches per deploy:** a release is switched twice, first on the integration distribution
  and then on the real one. Each switch is a distribution update plus an invalidation, so a deploy
  takes a few minutes longer than with one distribution.
- **Rollback speed:** a rollback takes the alarm delay (CloudFront metrics arrive a few minutes late,
  and 2 of 3 minutes must breach), then the distribution update and the invalidation (a few minutes
  each). Deploy runs report the activation timing in their job summary. Measure the full alarm-to-restored
  time with the break-frontend demo.
- **A failed switch after the claim:** if the distribution update fails after the rollback Lambda
  claimed the bad deployment, later alarms skip it. Recover with `deployment:restore` or `frontend-restore`.
- **No sign-in:** the page is public and doesn't call the API. Bringing login back means restoring
  #23's app, its build inputs (the API stack outputs) and its end-to-end test.
