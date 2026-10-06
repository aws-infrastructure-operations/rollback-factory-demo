# FE-03: Frontend app: login page + API page

**Story requirements:** 3 (login page + page calling GET/POST), 4 (same Cognito pool, ID token to the API)
**Depends on:** FE-01 (can run in parallel with FE-02)
**Branch:** `feature/frontend-app`

## Goal

A small Vite + plain TypeScript app in `aws-frontend-cloudfront/app/` that signs in against the
API's user pool and calls `GET`/`POST` `/users` and `/messages` on `api-user-<env>`.

## Scope

- **Pages** (multi-page Vite build, no SPA fallback needed):
  - `index.html`, the login page: e-mail + password form.
    - Signs in with Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`), using `fetch` to
      `https://cognito-idp.<region>.amazonaws.com/`. No Amplify.
    - Handles `NEW_PASSWORD_REQUIRED` with a "set new password" step (`RespondToAuthChallenge`).
    - Stores the ID token, access token and refresh token in `sessionStorage`, then redirects to `app.html`.
  - `app.html`, the API page:
    - redirects to `index.html` if there is no valid token
    - shows the signed-in user and a sign-out button
    - two panels (users, messages), each with a "GET" button and a "POST" form (`{ "message": "..." }`)
    - shows status code and response body, including 400 / 401 errors
    - sends `Authorization: <ID token>`
    - refreshes the ID token with `REFRESH_TOKEN_AUTH` when it expires
- **Config at build time:** `VITE_API_URL`, `VITE_USER_POOL_ID`, `VITE_USER_POOL_CLIENT_ID`,
  `VITE_REGION`, `VITE_RELEASE_ID`.
  - Show the release id in the page footer, so a rollback is visible.
  - Commit an `.env.example`. A local `npm run dev` reads `.env.local`.
- **Hashed asset names** (Vite default) so assets can be cached forever. Only the HTML is `no-cache`.
- **Unit tests** for the auth client (mocked `fetch`) and the API client (header and body shape).
- Accessibility basics: labelled inputs, buttons, visible focus, errors announced (`role="alert"`).

## Acceptance criteria

- `npm run app:build` with the env vars set produces `dist/` with `index.html`, `app.html` and hashed assets.
- Running locally against dev: sign in with a user created by the API's `npm run user:create`,
  then all four calls return 200/201. Sign out returns to the login page.
- A wrong password shows the Cognito error message. No token is stored.

## Notes

- Tokens in `sessionStorage` are fine for a demo. Note in the README that a production app would
  use the Hosted UI / PKCE and keep the refresh token out of JS.
