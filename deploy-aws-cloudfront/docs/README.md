# frontend-user tickets

These tickets split [story-implementation.md](../story-implementation.md) into work items.
Each ticket is one branch cut from `origin/main` and one PR.

## Order

| Ticket | Title | Story req. | Depends on | Branch |
|---|---|---|---|---|
| [FE-01](FE-01-cdk-scaffold.md) | CDK project scaffold, config and naming | 1, 2 | – | `feature/frontend-scaffold` |
| [FE-02](FE-02-hosting.md) | Private S3 site bucket behind CloudFront (OAC, HTTPS) | 5, 6 | FE-01 | `feature/frontend-hosting` |
| [FE-03](FE-03-app.md) | Frontend app: login page + API page | 3, 4 | FE-01 | `feature/frontend-app` |
| [FE-04](FE-04-releases-and-manifest.md) | Versioned releases, build manifest, activation | 6, 7 | FE-02, FE-03 | `feature/frontend-releases` |
| [FE-05](FE-05-deployments-table.md) | DynamoDB deployments table + record / list / verify | 8 | FE-04 | `feature/frontend-deployments-table` |
| [FE-06](FE-06-integration-tests.md) | Integration tests (smoke + end to end) | 9 | FE-04 | `feature/frontend-integration-tests` |
| [FE-07](FE-07-alarms.md) | 4xx / 5xx error-rate alarms + SNS (us-east-1) | 10 | FE-02 | `feature/frontend-alarms` |
| [FE-08](FE-08-rollback-lambda.md) | Rollback Lambda (origin path + invalidation) | 11 | FE-05, FE-07 | `feature/frontend-rollback` |
| [FE-09](FE-09-github-workflow.md) | GitHub workflow: deploy, test, promote to prod | 12 | FE-05, FE-06 | `feature/frontend-workflow` |
| [FE-10](FE-10-demo-and-docs.md) | Break-frontend demo, README, story status | – | FE-08, FE-09 | `feature/frontend-demo` |
| [FE-11](FE-11-integration-distribution.md) | Integration distribution: test each release before clients get it | 9, 12 | FE-09 | `feature/frontend-integration-distribution` |
| [FE-12](FE-12-simple-page.md) | Simple page instead of sign-in + API page | 3, 4 (out of scope for now) | FE-11 | `feature/frontend-simple-page` |

FE-02 and FE-03 can run in parallel; so can FE-05/FE-06/FE-07 once FE-04 is in.

## Guides

- [Sign-in with Microsoft Entra ID](entra-id-sign-in.md): planned; only the people assigned to an Entra ID app may use the dashboard.

## Decisions already made

These apply to every ticket.

- **Stack:** AWS CDK with TypeScript. The app is **Vite + React**.
- **Naming:** the distribution keeps the story's name, `frontend-user-<env>`. Every other resource is
  `rollback-factory-demo-<resource>-<env>`, the same as the API.
- **Regions:** two stacks per environment.
  - `rollback-factory-demo-frontend-<env>` in `AWS_REGION` (eu-central-1): site bucket, distribution,
    deployments bucket, deployments table.
  - `rollback-factory-demo-frontend-alarms-<env>` in **us-east-1**: alarms, SNS topic, rollback Lambda.
    CloudFront only publishes metrics there.
- **API:** CORS already allows `*`, and the user pool client (`rollback-factory-demo-client-<env>`)
  is public with `USER_PASSWORD_AUTH` and SRP enabled. No API change is needed.
- **Inputs from the API stack** (`rollback-factory-demo-<env>` outputs): `ApiUrl`, `UserPoolId`, `UserPoolClientId`.
  Not used since FE-12 (sign-in out of scope).
- **Rollback:** alarm → SNS → rollback Lambda does alarm rollbacks. Workflows only switch back when
  their own integration tests fail.
- **SNS:** topics with `enforceSSL: true` need an explicit allow for `cloudwatch.amazonaws.com`.
- **CI auth:** access-key secrets per GitHub environment (`dev`, `prod`), variable `AWS_REGION`.
- **Bucket per deployment:** one versioned deployments bucket per environment, with the timestamp in
  the object key (same deviation as the API).
