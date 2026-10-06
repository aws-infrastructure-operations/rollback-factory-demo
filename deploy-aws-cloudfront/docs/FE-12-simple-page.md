# FE-12: Simple page instead of sign-in + API page

**Story requirements:** 3, 4 (sign-in and the API page are out of scope for now)
**Depends on:** FE-11
**Branch:** `feature/frontend-simple-page`

## Goal

The distribution serves something simple: one static page that shows which environment and release
it is. Sign-in and calling the API are out of scope for now.

## Scope

- **App:** one page, `index.html`, showing:
  - `frontend-user-<env>`, the environment, the release id and the build time
  - the release id again in the footer, so activations and rollbacks stay visible
  - It keeps a script and a stylesheet, so a broken release with missing assets still produces
    403s for the alarm and the break demo.
- **Removed:**
  - the login page, the API page, the Cognito, session and API clients, and their unit tests
  - the Cognito test-user helper and its SDK dependency
  - They stay in git history (FE-03, PR #23).
- **No API dependency:**
  - `release:build` no longer reads the api-user stack. It passes `VITE_ENV`, `VITE_RELEASE_ID` and
    `VITE_BUILT_AT`.
  - The manifest no longer has the API fields, and the config no longer has `apiStackName`.
- **Tests:**
  - **End to end:** the browser test loads the page and checks that its scripts and styles applied,
    that it shows the environment and the release served, and that there are no console or HTTP errors.
  - **Smoke:** the smoke test expects `index.html` as the only HTML file.
- **Demo traffic:** `demo:traffic` loads `index.html` and what it references.

## Acceptance criteria

- `/` on both distributions shows the environment and the release they serve.
- The frontend deploys in an environment where the api-user stack doesn't exist.
- The integration tests pass without Cognito permissions.
