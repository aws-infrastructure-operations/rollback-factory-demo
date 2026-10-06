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
