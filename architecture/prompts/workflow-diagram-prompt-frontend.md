# Workflow diagram prompt (frontend-user)

A prompt for an image model (e.g. ChatGPT) that draws the GitHub Actions workflows of
`frontend-user`: the PR checks, the integration-first deploy (dev, then prod), the manual restore
and the break-frontend demo, and where the alarm-driven rollback takes over in AWS. It follows
[`frontend.yml`](../../.github/workflows/frontend.yml),
[`frontend-deploy`](../../.github/actions/frontend-deploy/action.yml),
[`frontend-restore.yml`](../../.github/workflows/frontend-restore.yml) and
[`break-frontend-demo.yml`](../../.github/workflows/break-frontend-demo.yml). Update it when those
change. The AWS side is drawn by
[`architecture-diagram-prompt-frontend.md`](architecture-diagram-prompt-frontend.md).

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with lanes 1–2 (checks and
deploy), and one with lanes 3–4 (restore and demo).

## Prompt

```text
Create a clean, professional CI/CD workflow diagram (landscape, 16:9, white background) in a flat flowchart style: rounded rectangles for steps, diamonds for decisions, small GitHub Actions logo in the corner of each lane title. Use short, exactly spelled labels — no invented text, no lorem ipsum. Add a small legend for the colors and arrow styles.

TITLE: "frontend-user — GitHub Actions workflows (rollback-factory-demo)"

LAYOUT: four horizontal swimlanes stacked top to bottom, each flowing left to right. A thin vertical dashed line near the right edge separates "GitHub Actions" (left) from "AWS" (right, a narrow column with AWS icons: "Amazon CloudFront frontend-user-<env>-integration" (blue), "Amazon CloudFront frontend-user-<env>" (green), "Amazon S3 releases/<id>", "Amazon DynamoDB frontend-deployments", "AWS Lambda rollback-service").

LANE 1 — "frontend.yml · pull request" (grey)
  Trigger chip: "pull_request (deploy-aws-cloudfront/**)"
  Steps: "npm ci" → "typecheck" → "unit tests" → "app build" → "cdk synth dev + prod" → green end chip "checks pass"

LANE 2 — "frontend.yml · push to main / manual" (blue, the largest lane)
  Trigger chips: "push main", "workflow_dispatch (promote_to_prod)"
  First box "test" (same steps as lane 1, collapsed into one box), then two large boxes in a row:
    "deploy dev" → "deploy prod"
  Small label on the arrow into "deploy prod": "push, or promote_to_prod = true"
  Small caption under both: "frontend-deploy action · one change per environment at a time"
  Expand "deploy dev" below it as a step chain:
    "cdk bootstrap (main region + us-east-1)" → "read the releases both distributions serve (live:context)" →
    "cdk deploy --all (both keep their release)" → "build release" → "upload release + manifest" →
    "make it live on the integration distribution" → "integration tests (smoke + Playwright end to end)"
  Diamond "tests pass?":
    no  → red end chip "stop · frontend-user-<env> untouched · failures in job summary"
    yes → "make the same release live on frontend-user-<env>" → "record (release, invalidation, previous)" →
          "mark verified" → green end chip "timing + history in summary"
  Dashed grey arrows from these steps to the AWS column icons:
    upload → "Amazon S3"
    live on integration → "CloudFront …-integration"; live on frontend-user-<env> → "CloudFront frontend-user-<env>"
    record / verified → "Amazon DynamoDB"

LANE 3 — "frontend-restore.yml · manual" (purple)
  Trigger chip: "workflow_dispatch (environment, release, reason)"
  Steps: "restore the release (origin path + invalidation, waits)" → "integration tests" →
         "mark verified" → green end chip "deployment history in summary"
  Caption: "shares the deploy lock: never runs while a deploy to that environment runs"
  Dashed purple arrow from "restore the release" to "CloudFront frontend-user-<env>" and "Amazon DynamoDB".

LANE 4 — "break-frontend-demo.yml · manual, dev only" (orange)
  Trigger chip: "workflow_dispatch (traffic_minutes = 12)"
  Steps: "preflight: dev has a verified release to roll back to" → "build release" →
         "upload it broken (HTML without assets/)" → "activate + record (no tests, never verified)" →
         "load the site for N minutes" → end chip "summary: still broken, or which release is live again"
  From "load the site", a solid red arrow crosses into the AWS column:
    "Amazon CloudWatch 4xx alarm (us-east-1)" → "Amazon SNS" → "AWS Lambda rollback-service" → "frontend-user-dev back on the previous verified release"
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
- **Two distributions:** each release goes live on `frontend-user-<env>-integration` first (no
  alarms), is tested there, and only then the same release goes live on `frontend-user-<env>`.
  "Live" means the distribution's origin path points at `releases/<id>` and an invalidation ran.
- **Failed tests:** the deploy stops; `frontend-user-<env>` was never touched, so nothing has to be
  switched back. Workflows never trigger a rollback — that is the 4xx/5xx alarm (us-east-1) → SNS →
  rollback-service path.
- **Locks:** `frontend-deploy-<env>` is shared by the deploy, the restore and the break-frontend
  demo, so they never run at the same time against one environment. PR checks have their own group.
- **Broken demo release:** uploaded without its `assets/`, so every script and style answers 403.
  It is recorded but never verified, so the rollback goes back past it.
- **Not in the diagram:** the API Gateway, Lambda, DNS and rollback-service workflows.
