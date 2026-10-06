# Architecture diagram prompt (api-user)

A prompt for an image model (e.g. ChatGPT) that draws the `api-user` architecture: the request
path, the alarm-driven rollback and the CI pipeline. It follows
[`lib/api-user-stack.ts`](../lib/api-user-stack.ts) and the `api-gateway*.yml` workflows; update it
when those change.

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with the request and CI flows,
and one with only the rollback flow (arrows A–F).

## Prompt

```text
Create a clean, professional AWS architecture diagram (landscape, 16:9, white background) using official AWS Architecture Icons and AWS group styles. Use short, exactly spelled labels — no invented text, no lorem ipsum. Number the arrows of the request flow (1–5) and the rollback flow (A–F) and add a small legend explaining them.

TITLE: "api-user — alarm-driven rollback (rollback-factory-demo)"

LAYOUT (left to right):

1) LEFT — "Clients"
   - "User / Bruno / Frontend" (user icon)
   - "GitHub Actions" (GitHub logo) with a small vertical pipeline next to it:
     "dev → testing → staging → prod". Inside one environment show the steps:
     "cdk deploy → tests on stage 'integration' → promote to v1 → record → verify"

2) CENTER — an "AWS Cloud" group containing a "Region eu-central-1" group, containing:
   a) "Amazon Cognito" — label "User pool: rollback-factory-demo-users-<env>"
   b) "Amazon API Gateway" — label "REST API: api-user-<env>"
      Inside it, two stage boxes stacked:
        - "Stage v1  (lambdaAlias = live)"
        - "Stage integration  (lambdaAlias = integration)"
      Small text under the API: "GET/POST /users, /messages · Cognito authorizer · request validator"
   c) "AWS Lambda" — label "rollback-factory-demo-handler-<env>" with two alias chips:
        "alias: live" and "alias: integration"
   d) "Amazon CloudWatch Logs" — label "Access logs"
   e) "Amazon CloudWatch" — a box with 5 alarm chips:
        "4xx-rate", "5xx-rate" (red, these trigger rollback),
        "lambda-4xx-rate", "lambda-5xx-rate" (amber, block rollback),
        "lambda-errors" (grey, notify only)
   f) "Amazon SNS" — label "notifications topic" with an optional "e-mail" subscriber
   g) "AWS Lambda" — label "rollback-factory-demo-rollback-<env>"
   h) "Amazon DynamoDB" — label "deployments table"
   i) "Amazon S3" — label "OpenAPI specs (one per deployment)"

REQUEST FLOW (solid blue arrows, numbered):
 1  User → Cognito: "sign in → ID token"
 2  User → API Gateway stage v1: "request + ID token"
 3  API Gateway → Cognito: "authorizer validates token"
 4  Stage v1 → Lambda alias "live"; Stage integration → alias "integration" (dashed)
 5  API Gateway → CloudWatch Logs "access logs" → CloudWatch "metric filters → Lambda error metrics"

ROLLBACK FLOW (solid red arrows, lettered):
 A  CloudWatch alarm "4xx-rate"/"5xx-rate" → SNS topic
 B  SNS → rollback Lambda (filter: only the 4xx/5xx-rate alarms)
 C  rollback Lambda → DynamoDB: "latest deployment < X min? find previous verified"
 D  rollback Lambda → CloudWatch: "is the Lambda at fault? (paired lambda alarms)" — if yes: "skip"
 E  rollback Lambda → S3: "get previous OpenAPI spec"
 F  rollback Lambda → API Gateway stage v1: "re-import spec + redeploy v1 (keeps alias live)"

CI FLOW (grey dashed arrows):
 - GitHub Actions → API Gateway / Lambda: "deploy + promote"
 - GitHub Actions → S3: "store spec"
 - GitHub Actions → DynamoDB: "record + verify deployment"

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```
