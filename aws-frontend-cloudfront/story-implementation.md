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

In progress. Nothing has been deployed yet.
The work is split into tickets FE-01 to FE-10 in [docs/](docs/README.md).

### Requirements

| # | Requirement | Status | PR |
|---|---|---|---|
| 1 | AWS CDK with TypeScript | Done (FE-01) | #21 |
| 2 | Frontend name `frontend-user-dev` / `frontend-user-prod` | Done (FE-01, FE-02) | #21, #22 |
| 3 | Login page + page calling the API GET and POST endpoints | Done (FE-03) | #23 |
| 4 | Cognito sign-in using the API's user pool | Done (FE-03) | #23 |
| 5 | Private S3 bucket behind CloudFront (OAC, HTTPS only) | Done (FE-02) | #22 |
| 6 | Versioned releases selected by origin path | Done (FE-02, FE-04) | #22, #24 |
| 7 | Build manifest stored in S3 | Done (FE-04, with the bucket-per-env deviation) | #24 |
| 8 | DynamoDB table recording each deployment | Done (FE-05) | #25 |
| 9 | Integration steps | Done (FE-06) | |
| 10 | 4xx and 5xx alarms with optional SNS notification | Not started | |
| 11 | SNS → rollback Lambda (within X minutes, previous release, invalidate) | Not started | |
| 12 | GitHub workflow: deploy, test, promote to prod, rollback | Not started | |

### Notes for implementation

- **Naming:** follow the API project: keep the story's name for the distribution (`frontend-user-<env>`) and name every other resource `rollback-factory-demo-<resource>-<env>`.
- **S3 bucket per deployment:** as with the API, a single versioned bucket per environment with the timestamp in the key is likely better than one bucket per deployment (bucket limits, scattered history).
- **CloudFront alarms:** CloudFront metrics are only published in `us-east-1`, so the alarms (and the SNS topic + rollback Lambda they notify, or a cross-region subscription) must live there.
- **Rollback speed:** changing the origin path redeploys the distribution (a few minutes), and the invalidation takes a little longer. Worth measuring during the first demo.
