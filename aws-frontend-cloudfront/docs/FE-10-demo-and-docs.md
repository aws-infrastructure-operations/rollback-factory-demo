# FE-10: Break-frontend demo, README, story status

**Story requirements:** – (demo + documentation)
**Depends on:** FE-08, FE-09
**Branch:** `feature/frontend-demo`

## Goal

A repeatable demo of the alarm-driven frontend rollback, and docs at the same level as `aws-api-gateway/`.

## Scope

- `.github/workflows/break-frontend-demo.yml` (manual, dev only), modelled on `break-api-demo.yml`:
  1. check dev has a verified release to roll back to
  2. build + upload + activate a **broken release** (`--break missing-assets`: the HTML references
     assets that aren't uploaded, so the browser gets 403s) and record it **without** running the
     integration tests
  3. send traffic to the site and its assets for `traffic_minutes` (`npm run demo:traffic`)
  4. finish. The 4xx alarm → SNS → rollback Lambda path switches back on its own.
  - Shares the `frontend-deploy-dev` concurrency group.
- `scripts/generate-traffic.ts`: requests `/`, `app.html` and every asset in the live release's
  HTML at a steady rate, and prints a status-code count every minute.
- `aws-frontend-cloudfront/README.md`: setup, scripts, env vars, regions and bootstrap, demo steps,
  known limitations (drift, unrecorded console changes, rollback speed with measured numbers).
- Update `story-implementation.md`: requirement table with status + PR numbers, deviations, limitations.
- Root `readme.md`: link the frontend project.

## Acceptance criteria

- Running the demo on dev fires the 4xx alarm. Within a few minutes the rollback Lambda restores the
  previous release, and the time from activation to restored is noted in the README.
- Every requirement row in the story has a status and a PR.
