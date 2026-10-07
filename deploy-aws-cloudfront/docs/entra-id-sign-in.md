# Sign-in with Microsoft Entra ID

Only the people assigned to an Entra ID app may open the dashboard: the page, its `/api/*` calls and
the actions behind them (API and CloudFront restores, Lambda alias moves). Today anyone with a site URL
can do all of that.

Status: **planned**. It comes after the custom domains (`deploy-aws-dns`, then the certificate and
domains on the distributions): the sign-in redirect URIs need those stable hostnames.

## How it works

```
Browser → CloudFront → Lambda@Edge (auth check) → site / dashboard API
                  ↘ no valid session → Entra ID sign-in → back to /_auth/callback → session cookie
```

1. A Lambda@Edge function runs on every request to both distributions of an environment (every
   behavior, `/api/*` included). Without a valid session cookie it redirects to Entra ID's sign-in
   (authorization code flow with PKCE, `state` and `nonce`).
2. After sign-in, Entra sends the user back to `/_auth/callback`. The function exchanges the code for
   tokens, checks the ID token (signature from Entra's JWKS, issuer, audience, expiry, nonce) and the
   email, and sets a signed session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, about 8 hours).
3. On later requests it only checks the cookie's signature: fast, no call to Entra.
4. It passes the signed-in email to the dashboard API in a header it sets itself (any incoming header
   of that name is dropped first, so it can't be spoofed). Restores, rollbacks and alias moves then
   record that email as the actor instead of `dashboard`.

Who gets access is decided in Entra: only users assigned to the app can sign in.

## Domains

| Distribution | Domain | Redirect URI |
|---|---|---|
| `frontend-user-dev` | `dev.rollback.ionuteliantudor.com` | `https://dev.rollback.ionuteliantudor.com/_auth/callback` |
| `frontend-user-dev-integration` | `dev-integration.rollback.ionuteliantudor.com` | `https://dev-integration.rollback.ionuteliantudor.com/_auth/callback` |
| `frontend-user-prod` | `rollback.ionuteliantudor.com` | `https://rollback.ionuteliantudor.com/_auth/callback` |
| `frontend-user-prod-integration` | `integration.rollback.ionuteliantudor.com` | `https://integration.rollback.ionuteliantudor.com/_auth/callback` |

## Steps in the Entra admin center (entra.microsoft.com)

1. **Register the app.** *App registrations → New registration*
   - Name: `rollback-factory-demo dashboard`
   - Supported account types: *Accounts in this organizational directory only* (single tenant)
   - Redirect URI: platform **Web**, `https://dev.rollback.ionuteliantudor.com/_auth/callback`
2. **Add the other redirect URIs.** *Authentication → Web → Add URI*: the other three from the table.
3. **Create a client secret.** *Certificates & secrets → New client secret*. Copy its **Value** right
   away: Entra shows it only once. Don't paste it anywhere but Secrets Manager (see [AWS secret](#the-client-secret-in-aws)).
4. **Ask for the email.** *Token configuration → Add optional claim → ID → `email`*.
   *API permissions*: keep `openid`, `profile`, `email` and `User.Read` (Microsoft Graph, delegated), then
   **Grant admin consent**.
5. **Allow only assigned people.** *Enterprise applications* → the same app:
   - *Properties → Assignment required? → **Yes***
   - *Users and groups → Add user/group* → pick the people who may use the dashboard.

   Anyone else gets "access denied" from Entra itself, before reaching the dashboard.
6. **People outside your tenant** (e.g. a Gmail address): *Users → Invite external user* first (they
   become guests), then assign them as in step 5.
7. **Note the ids** from the app's *Overview*: **Directory (tenant) ID** and **Application (client) ID**.
   They are not secrets.

Assigning individual users works on Entra ID Free; assigning **groups** needs Entra ID P1 or P2.

To give someone access later, assign them (step 5); to take it away, remove the assignment. Their
session cookie keeps working until it expires (about 8 hours).

## The client secret in AWS

Lambda@Edge runs from us-east-1 and can't have environment variables, so it reads the secret from
Secrets Manager in us-east-1 (and caches it). Store it once:

```sh
aws secretsmanager create-secret --region us-east-1 \
  --name rollback-factory-demo/entra-client-secret \
  --secret-string '<the client secret value>'
```

When it expires (Entra's default is 6 months to 2 years), create a new secret in Entra and update it:

```sh
aws secretsmanager put-secret-value --region us-east-1 \
  --name rollback-factory-demo/entra-client-secret \
  --secret-string '<the new value>'
```

The session cookies are signed with a separate key the stack generates (also in Secrets Manager); it
is never shared with Entra.

## Changes in the repo

1. **Edge auth function**: a Lambda@Edge function in the per-environment us-east-1 stack (the one that
   holds the certificate): sign-in redirect, `/_auth/callback`, cookie check, sign-out (`/_auth/logout`).
   The tenant and client ids are built into it (config), the client secret and the cookie key are read
   from Secrets Manager.
2. **Both distributions**: the function on the viewer request of every behavior, `/api/*` included.
3. **Allow-list in config (optional)**: a list of emails or a domain as a second check, on top of the
   Entra assignment, in case the app's settings are ever changed.
4. **Who did it**: the dashboard API takes the signed-in email from the header and records it as the
   actor of restores, rollbacks and alias moves; the page shows who is signed in.
5. **CI**: the smoke and e2e tests can't sign in to Entra (MFA). CI creates a short-lived session cookie
   for them, signed with the cookie key from Secrets Manager (its AWS credentials can read it).
6. **Tests and docs**: unit tests for the token and cookie checks, stack tests for the function on every
   behavior, this file and the README updated.

## Order

1. Custom domains: merge `deploy-aws-dns`, delegate `rollback.ionuteliantudor.com` (NS record at
   `ionuteliantudor.com`'s DNS host), then the certificate and domains on the distributions.
2. Entra: the steps above with those domains; send the tenant id and client id; store the client secret.
3. Edge auth: implemented on its own branch; dev first, then prod.

## Cost

Lambda@Edge is billed per request and duration: pennies at this traffic. Secrets Manager: $0.40 a
month per secret (two secrets). Entra ID Free covers the app and individual user assignments.

## Alternatives

- **CloudFront Function for the cookie check**, Lambda@Edge only for sign-in: cheaper per request,
  more moving parts. Worth it only with much more traffic.
- **Cognito with Entra ID as identity provider**: adds a user pool between the two; useful only if other
  identity providers (Google, local users) are needed too.
