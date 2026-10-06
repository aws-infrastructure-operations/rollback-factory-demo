# rollback-factory-demo

Demos of automatic, alarm-driven rollbacks on AWS. Each project is deployed by GitHub Actions through
`dev → testing → staging → prod`, tests every change on an integration target before clients get it,
and rolls itself back when its CloudWatch alarm fires shortly after a deployment.

| Project | What | Rolls back by | Docs |
|---|---|---|---|
| [`aws-api-gateway`](aws-api-gateway) | REST API `api-user-<env>` with a Cognito authorizer | re-importing the previous verified OpenAPI spec into stage `v1` | [README](aws-api-gateway/README.md), [story](aws-api-gateway/story-implementation.md) |
| [`aws-lambda`](aws-lambda) | Lambda function `service-lambda-<env>` with `integration` and `live` aliases, and a version archive (S3 + DynamoDB) | pointing `live` back at the previous version that went live, and restoring `$LATEST` from its archived zip | [README](aws-lambda/README.md) |
| [`aws-frontend-cloudfront`](aws-frontend-cloudfront) | static site `frontend-user-<env>` on CloudFront, showing the environment and release it serves | pointing the distribution's origin path back at the previous verified release | [README](aws-frontend-cloudfront/README.md), [story](aws-frontend-cloudfront/story-implementation.md), [tickets](aws-frontend-cloudfront/docs/README.md) |

The projects deploy independently. The frontend doesn't call the API for now (sign-in is out of scope).

**Demos** (manual workflows, dev only): `break-api-demo` and `break-frontend-demo` each deploy
something broken and send traffic until the alarm → SNS → rollback Lambda path restores the last
verified version.
