# FE-06: Integration tests (smoke + end to end)

**Story requirement:** 9 (smoke test the CloudFront URL, assets load, login + API calls end to end)
**Depends on:** FE-04
**Branch:** `feature/frontend-integration-tests`

## Goal

`FRONTEND_ENV=<env> npm run test:integration` proves the live site works: it is served correctly,
the release's assets load, and a real user can sign in and call the API from the browser.

## Scope

- **Smoke tests** (`integration/smoke.integration.test.ts`, `node:test` + `fetch`):
  - `https://<domain>/` returns 200 `text/html`, and the HTML contains the expected release id
  - `http://` redirects (301) to `https://`
  - every file in the live release's manifest returns 200 with the manifest's content type and
    sha256 (fetched through CloudFront)
  - `index.html` / `app.html` have `Cache-Control: no-cache`, and assets have `immutable`
  - an unknown path returns 403/404, not `index.html` (no SPA fallback)
  - the S3 object URL returns 403 (the bucket is private)
- **End-to-end** (`integration/e2e.integration.test.ts`, Playwright Chromium, headless):
  - creates a throwaway Cognito user (admin API, the same as the API's integration tests) and
    deletes it afterwards
  - signs in on `index.html` → lands on `app.html`
  - `GET` and `POST` on users and messages, each shows a 2xx status
  - signs out → back to the login page; `app.html` without a session redirects to login
  - fails on any browser console error or failed network request (CORS, 4xx/5xx on assets)
- The tests target the release currently live on the distribution, or `--release <id>` to assert
  that a given release is live (used by CI after activation).
- Test output in the GitHub job summary (`--test-reporter` like the API workflow).

## Acceptance criteria

- Against a healthy dev deployment, all tests pass in under ~2 minutes.
- Against a release with a missing asset (manually deleted), the smoke test fails, naming the file.
- No users are left in the pool after a run, pass or fail.

## Notes

- Playwright adds a browser download in CI: cache `~/.cache/ms-playwright` and install with
  `npx playwright install --with-deps chromium`.
- Wait for the activation's invalidation before testing, or tests may see the old release (FE-04 `--wait`).
