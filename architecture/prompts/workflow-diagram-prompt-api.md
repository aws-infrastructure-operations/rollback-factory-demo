# Workflow diagram prompt (api-user)

A prompt for an image model (e.g. ChatGPT) that draws the GitHub Actions workflows of `api-user`:
the PR checks, the integration-first deploy (dev, then prod), the manual restore and the break-api
demo, and where the alarm-driven rollback takes over in AWS. It follows
[`api-gateway.yml`](../../.github/workflows/api-gateway.yml),
[`api-gateway-deploy`](../../.github/actions/api-gateway-deploy/action.yml),
[`api-gateway-restore.yml`](../../.github/workflows/api-gateway-restore.yml) and
[`break-api-demo.yml`](../../.github/workflows/break-api-demo.yml). Update it when those change.
The AWS side is drawn by [`architecture-diagram-prompt-api.md`](architecture-diagram-prompt-api.md).

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with lanes 1–2 (checks and
deploy), and one with lanes 3–4 (restore and demo).

## Prompt

```text
Create a clean, professional CI/CD workflow diagram (landscape, 16:9, white background) in a flat flowchart style: rounded rectangles for steps, diamonds for decisions, small GitHub Actions logo in the corner of each lane title. Use short, exactly spelled labels — no invented text, no lorem ipsum. Add a small legend for the colors and arrow styles.

TITLE: "api-user — GitHub Actions workflows (rollback-factory-demo)"

LAYOUT: four horizontal swimlanes stacked top to bottom, each flowing left to right. A thin vertical dashed line near the right edge separates "GitHub Actions" (left) from "AWS" (right, a narrow column with AWS icons).

LANE 1 — "api-gateway.yml · pull request" (grey)
  Trigger chip: "pull_request (deploy-aws-api-gateway/**)"
  Steps: "npm ci" → "typecheck" → "unit tests" → "cdk synth dev + prod" → "Bruno collection in sync?"
  Diamond "in sync?": yes → green end chip "checks pass"; no → red end chip "fail: run collection:sync"

LANE 2 — "api-gateway.yml · push to main / manual" (blue, the largest lane)
  Trigger chips: "push main", "workflow_dispatch (promote_to_prod, dev_chaos_failure_rate)"
  First box "test" (same steps as lane 1, collapsed into one box), then two large boxes in a row:
    "deploy dev" → "deploy prod"
  Small label on the arrow into "deploy prod": "push, or promote_to_prod = true"
  Small caption under both: "api-gateway-deploy action · one deploy per environment at a time"
  Expand "deploy dev" below it as a step chain:
    "cdk bootstrap" → "sync Bruno collection" → "read what v1 serves (live:context)" →
    "cdk deploy → stage integration (v1 + alias live pinned)" →
    "integration tests on stage integration"
  Diamond "tests pass?":
    no  → red end chip "stop · v1 untouched · failures in job summary"
    yes → "promote to stage v1 + alias live" → "record (OpenAPI → S3, record → DynamoDB)" →
          "mark verified" → "sync rollback-service archive (users, messages, orders)" →
          green end chip "deployment history in summary"
  Dashed grey arrows from these steps to the AWS column icons:
    cdk deploy / promote → "Amazon API Gateway api-user-<env>" and "AWS Lambda (live / integration)"
    record → "Amazon S3" and "Amazon DynamoDB"
    sync → "AWS Lambda rollback-service"

LANE 3 — "api-gateway-restore.yml · manual" (purple)
  Trigger chip: "workflow_dispatch (environment, deployed_at, reason)"
  Steps: "restore deployment (rollback-service re-imports spec, redeploys v1)" →
         "integration tests" → "mark verified" → green end chip "deployment history in summary"
  Caption: "shares the deploy lock: never runs while a deploy to that environment runs"
  Dashed purple arrow from "restore deployment" to "AWS Lambda rollback-service" in the AWS column.

LANE 4 — "break-api-demo.yml · manual, dev only" (orange)
  Trigger chip: "workflow_dispatch (broken_ref = demo/break-api, traffic_minutes = 10)"
  Steps: "check out scripts (main) + broken API" → "preflight: dev has a deployment to roll back to" →
         "deploy broken API to dev" → "record it" → "send traffic for N minutes" → end chip "done (no rollback here)"
  From "send traffic", a solid red arrow crosses into the AWS column:
    "Amazon CloudWatch 5xx alarm" → "Amazon SNS" → "AWS Lambda rollback-service" → "API Gateway stage v1 restored"
  Caption on that red path: "rollback happens in AWS, not in the workflow"

LEGEND:
  grey = PR checks · blue = deploy · purple = manual restore · orange = demo
  green chip = success end · red chip = failure end · red solid arrow = alarm-driven rollback in AWS · dashed arrow = workflow touches an AWS resource

STYLE: flat, thin lines, rounded lane borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Environments:** `dev`, then `prod`; `prod` runs on every push to main, and on a manual run only
  when `promote_to_prod` is set.
- **Failed tests:** the deploy stops before promotion; stage `v1` and the `live` aliases are left as
  they are. Workflows never trigger a rollback — that is the alarm → SNS → rollback-service path.
- **Chaos input:** `dev_chaos_failure_rate` only reaches the dev deploy and is meant to fail the
  integration tests on purpose.
- **Locks:** `api-gateway-deploy-<env>` is shared by the deploy, restore and break-api demo, so they
  never run at the same time against one environment. PR checks have their own group.
- **Not in the diagram:** the Lambda, frontend and rollback-service workflows.
