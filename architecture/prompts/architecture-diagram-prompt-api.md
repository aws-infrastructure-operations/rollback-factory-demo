# Architecture diagram prompt (api-user)

A prompt for an image model (e.g. ChatGPT) that draws the `api-user` architecture: the request
path, the integration-first CI pipeline, the alarm-driven rollback through the shared rollback
service, and the manual restores. It follows
[`deploy-aws-api-gateway/lib/api-user-stack.ts`](../../deploy-aws-api-gateway/lib/api-user-stack.ts),
the rollback service's API Gateway manager in
[`rollback-service/lambda/managers/apigateway/`](../../rollback-service/lambda/managers/apigateway),
the dashboard's restore in
[`deploy-aws-cloudfront/lambda/dashboard-api/`](../../deploy-aws-cloudfront/lambda/dashboard-api) and
the `api-gateway*.yml` workflows. Update it when those change.

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with the request and CI flows,
and one with the rollback and restore flows (A–G, R1–R3).

## Prompt

```text
Create a clean, professional AWS architecture diagram (landscape, 16:9, white background) using official AWS Architecture Icons and AWS group styles. Use short, exactly spelled labels — no invented text, no lorem ipsum. Number the arrows of the request flow (1–5), the CI flow (D1–D5), the rollback flow (A–G) and the restore flow (R1–R3), and add a small legend explaining them.

TITLE: "api-user — integration-first deploys and alarm-driven rollback (rollback-factory-demo)"

LAYOUT (left to right):

1) LEFT — "Clients"
   - "User / Bruno" (user icon)
   - "GitHub Actions" (GitHub logo) with a small vertical pipeline next to it:
     "dev → prod". Inside one environment show the steps:
     "cdk deploy → tests on stage 'integration' → promote to v1 → record → verify"
   - A small manual workflow box under it: "api-gateway restore"
   - "Dashboard" (browser icon), label "AWS Control Center", with a small "Restore" button chip

2) CENTER — an "AWS Cloud" group containing a "Region eu-central-1" group, containing two groups:

   a) Group "deploy-aws-api-gateway":
      - "Amazon Cognito" — label "users"
      - "Amazon API Gateway" — label "REST API: api-user-<env>"
        Inside it, two stage boxes stacked:
          - "Stage v1  (lambdaAlias = live)"
          - "Stage integration  (lambdaAlias = integration)"
        Small text under the API: "GET/POST /users, /messages · Cognito authorizer · request validator"
      - Two "AWS Lambda" icons side by side — labels "api-users" (serves /users) and "api-messages" (serves /messages), each with two alias chips: "alias: live" and "alias: integration"
      - "Amazon CloudWatch Logs" — label "access logs"
      - "Amazon CloudWatch" — a box with 6 alarm chips:
          "api-user-4xx-rate", "api-user-5xx-rate" (red, these trigger the API rollback),
          "handler-4xx-rate", "handler-5xx-rate" (amber, block the API rollback),
          "lambda-api-users-errors", "lambda-api-messages-errors" (red, each rolls its own Lambda's live alias back)
      - "Amazon DynamoDB" — label "deployments", caption "current, verified, rolledBackAt"
      - "Amazon S3" — label "OpenAPI specs", caption "one export per deployment"

   b) Group "rollback-service" (shared by API Gateway, Lambda and CloudFront rollbacks):
      - "Amazon SNS" — label "rollback-notifications topic" with an optional "e-mail" subscriber
      - "AWS Lambda" — label "rollback-service", with a small router chip "alarm name → apigateway manager"

REQUEST FLOW (solid blue arrows, numbered):
 1  User → Cognito: "sign in → ID token"
 2  User → API Gateway stage v1: "request + ID token"
 3  API Gateway → Cognito: "authorizer validates token"
 4  Stage v1 → Lambda alias "live"; Stage integration → alias "integration" (dashed)
 5  API Gateway → CloudWatch Logs "access logs" → CloudWatch "metric filters → handler error rates"

CI FLOW (grey dashed arrows, D-numbered):
 D1  GitHub Actions → API Gateway / Lambda: "cdk deploy: new deployment on stage integration, alias integration"
 D2  GitHub Actions → stage integration: "integration tests"
 D3  GitHub Actions → stage v1 and alias live: "promote (only if tests pass)"
 D4  GitHub Actions → S3: "store OpenAPI export"
 D5  GitHub Actions → DynamoDB: "record + mark verified"

ROLLBACK FLOW (solid red arrows, lettered):
 A  CloudWatch alarm "api-user-4xx-rate" / "api-user-5xx-rate" → SNS topic
 B  SNS → rollback-service: "routed by alarm name: apigateway"
 C  rollback-service → DynamoDB: "latest deployment < 30 min old? not already rolled back?"
 D  rollback-service → CloudWatch: "is the handler at fault? (paired handler alarms)" — if yes: "skip"
 E  rollback-service → DynamoDB: "target: previous verified deployment; claim (one rollback for both alarms)"
 F  rollback-service → S3: "get its OpenAPI export"
 G  rollback-service → API Gateway stage v1: "re-import spec + redeploy v1 (keeps alias live); record rollback"

RESTORE FLOW (solid purple arrows, R-numbered):
 R1  "api-gateway restore" workflow → rollback-service: "restore a chosen deployment, then integration tests + verify"
 R2  Dashboard "Restore" → rollback-service: "restore a chosen deployment"
 R3  rollback-service → S3 and API Gateway stage v1: "re-import that export + redeploy v1; record"

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Environments:** the workflows deploy `dev`, then `prod`.
- **Names per environment:**
  - stack `deploy-aws-api-gateway-<env>` with:
    - the REST API `api-user-<env>` and its stages `v1` and `integration`
    - the user pool `rollback-factory-demo-users-<env>`
    - one backend Lambda per resource, `rollback-factory-demo-api-users-<env>` (`/users`) and
      `rollback-factory-demo-api-messages-<env>` (`/messages`), each with aliases `live` and `integration`
    - the access log group `rollback-factory-demo-api-access-logs-<env>`
    - the table `rollback-factory-demo-deployments-<env>` and the bucket `rollback-factory-demo-<account>-deployments-<env>`
  - alarms `rollback-factory-demo-apigateway-api-user-…-<env>`:
    - `4xx-rate` and `5xx-rate`: trigger the API rollback
    - `handler-4xx-rate` and `handler-5xx-rate`: block it while they are in ALARM
  - alarms `rollback-factory-demo-lambda-api-users-errors-<env>` and `…-api-messages-errors-<env>`: errors
    of that backend; the rollback service's Lambda manager moves that backend's `live` back (both
    backends are registered in `rollback-service/rollback-config.json`)
  - stack `rollback-service-<env>` (deployed first, shared with the Lambda and the frontend) with the
    rollback function `rollback-factory-demo-rollback-service-<env>` and the topic
    `rollback-factory-demo-rollback-notifications-<env>`
- **Stages and aliases:** each stage invokes the alias named by its `lambdaAlias` stage variable, so
  the `integration` stage tests the new code while `v1` keeps serving `live`.
- **What a rollback restores:** the API configuration only. It re-imports the previous verified
  deployment's OpenAPI export into the API and redeploys `v1`; the restored spec still invokes the
  `live` aliases, so the code is never rolled back. If the paired handler alarms show a backend is at
  fault, it skips the rollback; that backend's own errors alarm rolls its code back instead.
- **Rollback window:** only within 30 minutes of the latest deployment.
- **Manual restores:** the `api-gateway restore` workflow restores a recorded deployment, runs the
  integration tests and marks it verified. The dashboard's API panel lists the recorded deployments
  and its Restore button asks the rollback service to restore one. Both go through the same
  rollback service as the alarms.
- **Not in the diagram:** the frontend's distributions and the Lambda service; only the dashboard's
  Restore button appears.
