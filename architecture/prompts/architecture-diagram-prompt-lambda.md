# Architecture diagram prompt (service-lambda)

A prompt for an image model (e.g. ChatGPT) that draws the `service-lambda` architecture: callers,
the integration-first deploy, the version archive and the automatic and manual rollbacks through the
shared rollback service. It follows
[`deploy-aws-lambda/lib/lambda-service-stack.ts`](../../deploy-aws-lambda/lib/lambda-service-stack.ts),
the rollback service's Lambda manager in
[`rollback-service/lambda/managers/lambda/`](../../rollback-service/lambda/managers/lambda) with its
stack in [`rollback-service/lib/`](../../rollback-service/lib), and the `lambda*.yml` workflows.
Update it when those change.

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with the deploy flow (D1–D5),
and one with the rollback flow (A–G).

## Prompt

```text
Create a clean, professional AWS architecture diagram (landscape, 16:9, white background) using official AWS Architecture Icons and AWS group styles. Use short, exactly spelled labels — no invented text, no lorem ipsum. Number the arrows of the request flow (1–2), the deploy flow (D1–D5) and the rollback flow (A–G), and add a small legend explaining them.

TITLE: "service-lambda — integration-first deploys and automatic rollback (rollback-factory-demo)"

LAYOUT (left to right):

1) LEFT — "Clients"
   - "Callers" (generic client icon)
   - "GitHub Actions" (GitHub logo) with a small vertical pipeline next to it:
     "dev → prod". Inside one environment show the steps:
     "cdk deploy → tests on alias 'integration' → promote 'live' → sync"
   - Two small manual workflow boxes under it: "rollback by version" and "rollback to commit"

2) CENTER — an "AWS Cloud" group containing a "Region eu-central-1" group, containing four groups:

   a) Group "deploy-aws-lambda":
      - "AWS Lambda" — label "service-lambda-<env>"
      - Under it a row of small version tiles: "v1", "v2", "v3", "v4", caption "published versions (kept)"
      - Two alias tags pointing at tiles:
          "alias: live" → "v3" (green)
          "alias: integration" → "v4" (blue)
      - A separate tile "$LATEST"
      - "Amazon CloudWatch" — label "AWS/Lambda Errors" with three small metric lines:
          "live", "unqualified", "$LATEST" (no line for integration)
      - CloudWatch alarm chip "lambda-service-lambda-errors" (red), caption "≥ 1 error in 1 min"

   b) Group "rollback-service" (shared by API Gateway, Lambda and CloudFront rollbacks):
      - "Amazon SNS" — label "rollback-notifications topic"
      - "Amazon EventBridge" — label "scheduled check", caption "every 5 min"
      - "AWS Lambda" — label "rollback-service", with a small router chip "alarm name → lambda manager"
      - Small "AWS STS" icon next to it, caption "role scoped to one function"
      - Small file icon "rollback-config.json", caption "registered functions + alarms"

   c) Group "Version archive" (bottom, spanning under both groups, inside rollback-service):
      - "Amazon S3" — label "lambda-archive", caption "<fn>/<fn>-<version>.zip"
      - "Amazon DynamoDB" — label "lambda-archive", caption "VERSION#… + CURRENT (liveAt, stable, rolledBackAt)"

REQUEST FLOW (solid blue arrows, numbered):
 1  Callers → "alias: live": "invoke service-lambda-<env>:live"
 2  Callers → "$LATEST" (dashed): "unqualified call"

DEPLOY FLOW (grey dashed arrows, D-numbered):
 D1  GitHub Actions → service-lambda-<env>: "cdk deploy: new version v4 → alias integration (live stays on v3)"
 D2  GitHub Actions → "alias: integration": "integration tests"
 D3  GitHub Actions → "alias: live": "promote: live → v4 (only if tests pass)"
 D4  GitHub Actions → rollback-service: "sync"
 D5  rollback-service → S3 and DynamoDB: "archive v4, record deploy (liveAt)"

ROLLBACK FLOW (solid red arrows, lettered):
 A  Errors metrics (live, unqualified, $LATEST) → alarm "lambda-service-lambda-errors"
 B  Alarm → SNS topic → rollback-service (EventBridge also re-checks alarms still in ALARM every 5 min)
 C  rollback-service → STS: "assume role scoped to service-lambda-<env>"
 D  rollback-service → DynamoDB: "guards: deploy < 10 min ago? cooldown 3 min? max 2 in a row?"
 E  rollback-service → DynamoDB: "target: newest older version that went live, never rolled back"
 F  rollback-service → "alias: live": "live → v3"; and S3 → "$LATEST": "restore $LATEST from v3 zip"
 G  rollback-service → DynamoDB: "record rollback (CURRENT, v4 rolledBackAt)"

Also show, as a small note near the rollback-service group: "$LATEST-only failure → restore $LATEST only, alias unchanged".
Also show a thin grey arrow from the manual workflow boxes to rollback-service, labelled "manual rollback (waits for no running deploy)".

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Environments:** the workflows deploy `dev`, then `prod`.
- **Names per environment:**
  - stack `deploy-aws-lambda-<env>` with the function `service-lambda-<env>` and its alarm
    `rollback-factory-demo-lambda-service-lambda-errors-<env>`
  - stack `rollback-service-<env>` (deployed first, shared with the API and the frontend) with:
    - the rollback function `rollback-factory-demo-rollback-service-<env>`
    - the topic `rollback-factory-demo-rollback-notifications-<env>`
    - the table `rollback-factory-demo-lambda-archive-<env>`
    - the bucket `rollback-factory-demo-<account>-lambda-archive-<env>`
    - the scheduled check (EventBridge rule, every 5 minutes)
- **One rollback Lambda:** the rollback service picks its manager from the alarm name
  `rollback-factory-demo-<type>-<name>-<env>`: `lambda` here, `apigateway` and `cloudfront` for the
  other projects. Functions are registered for automatic rollback in `rollback-config.json`.
- **Scoped access:** the rollback Lambda's own role can't touch Lambda, S3 or DynamoDB. For each
  rollback it assumes a role, narrowed by a session policy to the one function, its folder in the
  archive bucket and its items in the table.
- **Aliases:** `integration` moves to every newly published version. `live` only moves on promotion
  (after the tests) or on a rollback.
- **Alarm:** watches errors on `live`, unqualified calls and `$LATEST`, never `integration`.
- **Guards:** an automatic rollback only happens within 10 minutes of the last deploy or rollback, at
  least 3 minutes after the previous rollback, and at most 2 times in a row (the count resets on the
  next deploy).
- **Rollback target:** the newest older version that went live (`liveAt`) and was never rolled back
  from. A version whose tests failed never went live, so it is never a target.
- **Manual rollbacks:** "rollback by version" invokes the rollback service for a chosen version (or
  the previous live one); "rollback to commit" resolves a deployed commit to its version and runs it.
  Both stop if a lambda deploy is running or queued, and support a dry run.
- **Not in the diagram:** the API, the frontend and the dashboard (which only reads the functions,
  aliases and versions). This stack is independent of them.
