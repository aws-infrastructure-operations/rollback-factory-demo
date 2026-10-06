# rollback-factory-demo

Demos of automatic, alarm-driven rollbacks on AWS. Each project is deployed by GitHub Actions to
`dev`, then `prod`, and rolls itself back when its CloudWatch error-rate alarm fires shortly after a
deployment.

| Project | What | Rolls back by | Docs |
|---|---|---|---|
| [`aws-api-gateway`](aws-api-gateway) | REST API `api-user-<env>` with a Cognito authorizer | re-importing the previous verified OpenAPI spec into stage `v1` | [README](aws-api-gateway/README.md), [story](aws-api-gateway/story-implementation.md) |
| [`aws-frontend-cloudfront`](aws-frontend-cloudfront) | static site `frontend-user-<env>` on CloudFront that signs in with the API's user pool and calls the API | pointing the distribution's origin path back at the previous verified release | [README](aws-frontend-cloudfront/README.md), [story](aws-frontend-cloudfront/story-implementation.md), [tickets](aws-frontend-cloudfront/docs/README.md) |

The frontend is built against the API's stack outputs, so deploy the API to an environment first.

**Demos** (manual workflows, dev only): `break-api-demo` and `break-frontend-demo` each deploy
something broken and send traffic until the alarm → SNS → rollback Lambda path restores the last
verified version.
