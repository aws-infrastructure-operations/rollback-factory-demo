# Architecture diagram prompt (service-lambda)

A prompt for an image model (e.g. ChatGPT) that draws the `service-lambda` architecture: callers,
the integration-first deploy, the version archive and the automatic and manual rollbacks. It follows
[`lib/lambda-service-stack.ts`](../lib/lambda-service-stack.ts), the rollback function in
[`lambda/rollback/`](../lambda/rollback) and the `lambda*.yml` workflows. Update it when those change.

It replaces the original repo's prompt, which showed a single environment, `live` moving on every
deploy, and the old names.

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
     "dev → testing → staging → prod". Inside one environment show the steps:
     "cdk deploy → tests on alias 'integration' → promote 'live' → sync"
   - Two small manual workflow boxes under it: "rollback by version" and "rollback to commit"

2) CENTER — an "AWS Cloud" group containing a "Region eu-central-1" group, containing four groups:

   a) Group "Service":
      - "AWS Lambda" — label "service-lambda-<env>"
      - Under it a row of small version tiles: "v1", "v2", "v3", "v4", caption "published versions (kept)"
      - Two alias tags pointing at tiles:
          "alias: live" → "v3" (green)
          "alias: integration" → "v4" (blue)
      - A separate tile "$LATEST"

   b) Group "Detection":
      - "Amazon CloudWatch" — label "AWS/Lambda Errors" with three small metric lines:
          "live", "unqualified", "$LATEST" (no line for integration)
      - CloudWatch alarm chip "service-lambda-errors" (red), caption "≥ 1 error in 1 min"
      - "Amazon SNS" — label "lambda-notifications topic"
      - "Amazon EventBridge" — label "lambda-rollback-check", caption "every 5 min"

   c) Group "Rollback":
      - "AWS Lambda" — label "lambda-rollback"
      - Small "AWS STS" icon next to it, caption "credentials scoped to one function"
      - Small file icon "rollback-config.json", caption "registered functions + alarms"

   d) Group "Version archive" (bottom, spanning under Detection and Rollback):
      - "Amazon S3" — label "lambda-artifacts", caption "<fn>/<fn>-<version>.zip"
      - "Amazon DynamoDB" — label "lambda-versions", caption "VERSION#… + CURRENT (liveAt, stable, rolledBackAt)"

REQUEST FLOW (solid blue arrows, numbered):
 1  Callers → "alias: live": "invoke service-lambda-<env>:live"
 2  Callers → "$LATEST" (dashed): "unqualified call"

DEPLOY FLOW (grey dashed arrows, D-numbered):
 D1  GitHub Actions → Service: "cdk deploy: new version v4 → alias integration (live stays on v3)"
 D2  GitHub Actions → "alias: integration": "integration tests"
 D3  GitHub Actions → "alias: live": "promote: live → v4 (only if tests pass)"
 D4  GitHub Actions → lambda-rollback: "sync"
 D5  lambda-rollback → S3 and DynamoDB: "archive v4, record deploy (liveAt)"

ROLLBACK FLOW (solid red arrows, lettered):
 A  Errors metrics (live, unqualified, $LATEST) → alarm "service-lambda-errors"
 B  Alarm → SNS topic → lambda-rollback (EventBridge also re-checks every 5 min)
 C  lambda-rollback → STS: "assume role scoped to service-lambda-<env>"
 D  lambda-rollback → DynamoDB: "guards: deploy < 10 min ago? cooldown? limit?"
 E  lambda-rollback → DynamoDB: "target: newest older version that went live, never rolled back"
 F  lambda-rollback → "alias: live": "live → v3"; and S3 → "$LATEST": "restore $LATEST from v3 zip"
 G  lambda-rollback → DynamoDB: "record rollback (CURRENT, v4 rolledBackAt)"

Also show, as a small note near the Rollback group: "$LATEST-only failure → restore $LATEST only, alias unchanged".
Also show a thin grey arrow from the manual workflow boxes to "alias: live", labelled "manual rollback (same lock as deploys)".

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Names per environment:**
  - function `service-lambda-<env>`
  - alarm `rollback-factory-demo-service-lambda-errors-<env>`
  - topic `rollback-factory-demo-lambda-notifications-<env>`
  - rollback function `rollback-factory-demo-lambda-rollback-<env>`
  - table `rollback-factory-demo-lambda-versions-<env>`
  - bucket `rollback-factory-demo-<account>-lambda-artifacts-<env>`
  - schedule `rollback-factory-demo-lambda-rollback-check-<env>`
- **Aliases:** `integration` moves to every newly published version. `live` only moves on promotion
  (after the tests) or on a rollback.
- **Alarm:** watches errors on `live`, unqualified calls and `$LATEST`, never `integration`.
- **Rollback target:** the newest older version that went live (`liveAt`) and was never rolled back
  from. A version whose tests failed never went live, so it is never a target.
- **Not in the diagram:** the API and the frontend. This stack is independent of them.
