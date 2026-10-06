# aws-api-gateway

AWS CDK (TypeScript) app for the `api-user-<env>` REST API. Implementation plan: [story-implementation.md](story-implementation.md).

## What gets deployed (per environment)

| Resource | Name |
|---|---|
| REST API (regional) | `api-user-dev` / `api-user-prod`, stage `v1` |
| Cognito user pool + app client | `api-user-<env>-users` / `api-user-<env>-client` |
| Cognito authorizer | `api-user-<env>-cognito` (`Authorization: <ID token>`) |
| Lambda backend (Node 24, arm64) | `api-user-<env>-handler` |

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
npm run deploy:dev       # cdk deploy -c env=dev
npm run deploy:prod      # cdk deploy -c env=prod
```

The first deploy to an account/region needs `npx cdk bootstrap`.

Stack outputs (exported as `api-user-<env>-<Name>`): `ApiId`, `ApiUrl`, `StageName`, `UserPoolId`, `UserPoolClientId`.
