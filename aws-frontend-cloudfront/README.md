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
- **Outputs** (exported as `rollback-factory-demo-<output>-<env>`): `DistributionId`,
  `DistributionDomainName`, `SiteUrl`, `SiteBucketName`, `LiveReleaseId`.
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

## Scripts

| Command | Does |
|---|---|
| `npm run build` | typecheck (CDK app and frontend app) |
| `npm test` | unit tests |
| `npm run synth:dev` / `synth:prod` | synthesize both stacks |
| `npm run app:dev` | run the app locally (reads `app/.env.local`) |
| `npm run app:build` | build the app into `dist/` (reads `VITE_*` from the environment or `app/.env.local`) |

## Context options

| Option | Default | Used by |
|---|---|---|
| `liveReleaseId` | – | origin path the distribution keeps (FE-02, FE-04) |
| `alarmNotifications` | `true` | alarm actions on/off (FE-07) |
| `alarmEmail` | – | e-mail subscription on the alarm topic (FE-07) |
| `rollbackWindowMinutes` | `30` | rollback Lambda window (FE-08) |
