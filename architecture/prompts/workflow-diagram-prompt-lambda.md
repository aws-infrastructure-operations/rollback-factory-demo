# Workflow diagram prompt (service-lambda)

A prompt for an image model (e.g. ChatGPT) that draws the GitHub Actions workflows of
`service-lambda`: the PR checks, the integration-first deploy (dev, then prod), the self-updating
commit dropdown and the two manual rollbacks, and where the alarm-driven rollback takes over in AWS.
It follows [`lambda.yml`](../../.github/workflows/lambda.yml),
[`lambda-deploy`](../../.github/actions/lambda-deploy/action.yml),
[`lambda-rollback-by-version.yml`](../../.github/workflows/lambda-rollback-by-version.yml) and
[`lambda-rollback-to-commit.yml`](../../.github/workflows/lambda-rollback-to-commit.yml). Update it
when those change. The AWS side is drawn by
[`architecture-diagram-prompt-lambda.md`](architecture-diagram-prompt-lambda.md).

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with lanes 1–2 (checks and
deploy), and one with lanes 3–4 (manual rollbacks).

## Prompt

```text
Create a clean, professional CI/CD workflow diagram (landscape, 16:9, white background) in a flat flowchart style: rounded rectangles for steps, diamonds for decisions, small GitHub Actions logo in the corner of each lane title. Use short, exactly spelled labels — no invented text, no lorem ipsum. Add a small legend for the colors and arrow styles.

TITLE: "service-lambda — GitHub Actions workflows (rollback-factory-demo)"

LAYOUT: four horizontal swimlanes stacked top to bottom, each flowing left to right. A thin vertical dashed line near the right edge separates "GitHub Actions" (left) from "AWS" (right, a narrow column with AWS icons: "AWS Lambda service-lambda-<env> (aliases live / integration)", "Amazon S3 version zips", "Amazon DynamoDB lambda-archive", "AWS Lambda rollback-service").

LANE 1 — "lambda.yml · pull request" (grey)
  Trigger chip: "pull_request (deploy-aws-lambda/**)"
  Steps: "npm ci" → "typecheck" → "unit tests" → "cdk synth dev + prod" → green end chip "checks pass"

LANE 2 — "lambda.yml · push to main / manual" (blue, the largest lane)
  Trigger chips: "push main", "workflow_dispatch (promote_to_prod)"
  First box "test" (same steps as lane 1, collapsed into one box), then two large boxes in a row:
    "deploy dev" → "deploy prod"
  Small label on the arrow into "deploy prod": "push, or promote_to_prod = true"
  Small caption under both: "lambda-deploy action · one release per environment at a time"
  Expand "deploy dev" below it as a step chain:
    "cdk bootstrap" → "read the version live serves (live:context)" →
    "cdk deploy → new version on alias integration (live pinned)" →
    "integration tests on alias integration"
  Diamond "tests pass?":
    no  → red end chip "stop · live untouched · failures in job summary"
    yes → "promote live to the tested version" → "sync (archive version + record deploy)" →
          green end chip "versions in summary"
  From "deploy dev", a second branch (push to main only) to a small box:
    "update-commit-dropdown" → "read dev's last 5 live commits" → "rewrite rollback-to-commit options" →
    "commit + push [skip ci] (WORKFLOW_PAT)"
  A thin dotted arrow from that box down to lane 3's "commit" dropdown, label "fills the dropdown".
  Dashed grey arrows from these steps to the AWS column icons:
    cdk deploy / promote → "AWS Lambda service-lambda-<env>"
    sync → "AWS Lambda rollback-service" → "Amazon S3" and "Amazon DynamoDB"
    read last 5 live commits → "Amazon DynamoDB"

LANE 3 — "lambda-rollback-to-commit.yml · manual" (purple)
  Trigger chip: "workflow_dispatch (environment, commit ▾, dry_run)"
  Steps: "resolve commit → newest live version in that env" → arrow labeled "calls" into lane 4's first step
  Red end chip on the side: "commit never went live there → stop"

LANE 4 — "lambda-rollback-by-version.yml · manual or called" (dark purple)
  Trigger chip: "workflow_dispatch (environment, target_version, dry_run)"
  Steps: "stop if a lambda deploy is running or queued" → "take the release lock, check again" →
         "sync rollback metadata" → "pick target (empty = previous version that was live, never rolled back from)"
  Diamond "dry run?":
    yes → end chip "list versions + what would happen (nothing changed)"
    no  → "point live at the target" → "restore $LATEST from the version's zip in S3 (sha256 checked)" →
          "record rollback (CURRENT, rolledBackAt, stableFor)" → green end chip "rolled back"
  Dashed purple arrows to the AWS column: "point live" / "restore $LATEST" → "AWS Lambda service-lambda-<env>"; zip ← "Amazon S3"; record → "Amazon DynamoDB"

AWS COLUMN, bottom — a solid red path inside the AWS column only:
  "Amazon CloudWatch errors alarm" → "Amazon SNS" → "AWS Lambda rollback-service" → "live moved back"
  Caption: "automatic rollback happens in AWS, not in a workflow"

LEGEND:
  grey = PR checks · blue = deploy · purple = manual rollbacks
  green chip = success end · red chip = failure end · red solid arrow = alarm-driven rollback in AWS · dashed arrow = workflow touches an AWS resource · dotted arrow = workflow rewrites another workflow

STYLE: flat, thin lines, rounded lane borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Environments:** `dev`, then `prod`; `prod` runs on every push to main, and on a manual run only
  when `promote_to_prod` is set.
- **Failed tests:** the deploy stops before promotion and `live` is never moved. Workflows never
  trigger the automatic rollback — that is the errors alarm → SNS → rollback-service path.
- **Commit dropdown:** GitHub can't fill a dropdown at run time, so after each deploy to dev from
  main the `update-commit-dropdown` job writes dev's last 5 live commits into
  `lambda-rollback-to-commit.yml` and pushes it (`[skip ci]`, and the file is excluded from the push
  paths). Without the `WORKFLOW_PAT` secret it only logs a warning.
- **Commit → version:** version numbers differ per environment, so the commit is resolved in the
  chosen environment; rollback to commit then calls rollback by version.
- **Locks:** `lambda-release-<env>` is shared by the deploy and the rollback by version. The rollback
  also checks for running or queued `lambda.yml` runs before and after taking the lock.
- **What a manual rollback does:** moves `live`, restores `$LATEST` from the archived zip (no build,
  no new version), and records it like the automatic rollback (manual ones don't count towards the
  consecutive-rollback limit).
- **Not in the diagram:** the API Gateway, frontend and rollback-service workflows.
