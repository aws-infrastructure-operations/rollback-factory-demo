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
