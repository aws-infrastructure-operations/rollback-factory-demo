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

## Scripts

| Command | Does |
|---|---|
| `npm run build` | typecheck |
| `npm test` | unit tests |
| `npm run synth:dev` / `synth:prod` | synthesize both stacks |

## Context options

| Option | Default | Used by |
|---|---|---|
| `liveReleaseId` | – | origin path the distribution keeps (FE-02, FE-04) |
| `alarmNotifications` | `true` | alarm actions on/off (FE-07) |
| `alarmEmail` | – | e-mail subscription on the alarm topic (FE-07) |
| `rollbackWindowMinutes` | `30` | rollback Lambda window (FE-08) |
