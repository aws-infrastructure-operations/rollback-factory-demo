# FE-02: Private S3 site bucket behind CloudFront (OAC, HTTPS)

**Story requirements:** 5 (private S3, OAC, HTTPS only), 6 (origin path selects the release)
**Depends on:** FE-01
**Branch:** `feature/frontend-hosting`

## Goal

The CloudFront distribution `frontend-user-<env>` serves a private S3 bucket through Origin Access
Control. The active release is chosen by the origin path.

## Scope

- **Site bucket** `rollback-factory-demo-<account>-frontend-site-<env>`:
  - Block all public access, `enforceSSL`, S3-managed encryption, no website hosting.
  - Versioning is not needed: each release has its own prefix.
  - prod is retained, dev is `DESTROY` + `autoDeleteObjects`.
- **Distribution:**
  - comment / name `frontend-user-<env>`
  - S3 origin with **OAC** (`S3BucketOrigin.withOriginAccessControl`). The bucket policy only allows
    this distribution (`AWS:SourceArn`).
  - `viewerProtocolPolicy: REDIRECT_TO_HTTPS`, HTTP/2 + HTTP/3. (A minimum TLS version can only be set with a custom domain certificate; the default `*.cloudfront.net` certificate is used here.)
  - `defaultRootObject: index.html`
  - **origin path** `/releases/<liveReleaseId>`, from `-c liveReleaseId=` (same pattern as the API's
    `scripts/live-context.ts`). Without it, use `/releases/initial` and a placeholder page deployed
    by `BucketDeployment` into `releases/initial/`, so a fresh stack serves something.
  - cache policy: `CACHING_OPTIMIZED` by default. `index.html` and `app.html` get
    `Cache-Control: no-cache` when uploaded (FE-04).
  - **No SPA fallback** (no 403/404 → `index.html` custom error responses). The app has two real
    HTML pages, so a missing file stays a real 4xx and can trigger the 4xx alarm (FE-07).
  - standard logging is optional and off by default.
- **Outputs:** `DistributionId`, `DistributionDomainName`, `SiteUrl` (`https://<domain>`),
  `SiteBucketName`. Export them like the API (`exportName: resourceName(name)`).
- **Unit tests** on the synthesized template: OAC, no public access, HTTPS redirect, origin path
  taken from context, no custom error responses.

## Acceptance criteria

- After `cdk deploy -c env=dev`, the `SiteUrl` returns the placeholder page over HTTPS.
  `http://` redirects to `https://`.
- Direct S3 URLs for the bucket return 403.
- Deploying with `-c liveReleaseId=X` changes only the origin path.

## Notes

- `cdk deploy` without `liveReleaseId` would reset the origin path to `initial`. CI must always pass
  the live release (FE-04 adds `npm run live:context`), or a deploy undoes a rollback.
