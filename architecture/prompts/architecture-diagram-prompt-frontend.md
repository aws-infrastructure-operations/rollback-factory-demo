# Architecture diagram prompt (frontend-user)

A prompt for an image model (e.g. ChatGPT) that draws the `frontend-user` architecture: the two
CloudFront distributions in front of the private release bucket and the dashboard API, the
integration-first deploy, and the alarm-driven rollback through the shared rollback service. It
follows [`deploy-aws-cloudfront/lib/`](../../deploy-aws-cloudfront/lib), the dashboard API in
[`deploy-aws-cloudfront/lambda/dashboard-api/`](../../deploy-aws-cloudfront/lambda/dashboard-api), the
rollback service's CloudFront manager in
[`rollback-service/lambda/managers/cloudfront/`](../../rollback-service/lambda/managers/cloudfront) and
the `frontend*.yml` workflows. Update it when those change.

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with the request, dashboard
and deploy flows, and one with only the rollback flow (A–G).

## Prompt

```text
Create a clean, professional AWS architecture diagram (landscape, 16:9, white background) using official AWS Architecture Icons and AWS group styles. Use short, exactly spelled labels — no invented text, no lorem ipsum. Number the arrows of the request flow (1–3), the dashboard flow (4–6), the deploy flow (D1–D6) and the rollback flow (A–G), and add a small legend explaining them.

TITLE: "frontend-user — a release-versioned dashboard on CloudFront with alarm-driven rollback (rollback-factory-demo)"

LAYOUT (left to right):

1) LEFT — "Clients"
   - "Browser" (user icon) with a small screenshot-like tile next to it: "AWS Control Center dashboard" showing three panels "API Gateways", "Lambda Functions", "CloudFront Distributions"
   - "GitHub Actions" (GitHub logo) with a small vertical pipeline next to it:
     "dev → prod". Inside one environment show the steps:
     "build → upload release → integration distribution → tests → live distribution → record"

2) CENTER — an "AWS Cloud" group with TWO region groups side by side:

   a) Region group "eu-central-1" (larger, left):
      - "Amazon CloudFront" — label "frontend-user-<env>" (green, "live")
      - "Amazon CloudFront" — label "frontend-user-<env>-integration" (blue, "tests only"), below it
      - Each distribution has two path chips: "/*" and "/api/*"
      - "Amazon S3" — label "site bucket (private)" with three small folder tiles inside:
          "releases/20261006T110000Z", "releases/20261006T120000Z", "releases/20261006T123005Z"
      - "AWS Lambda" — label "dashboard-api", with a small "function URL (IAM auth)" tag
      - Small lock icons on the arrows from both distributions to the bucket and to dashboard-api, caption "Origin Access Control"
      - A small dotted box "read-only" next to dashboard-api with three icons: "Amazon API Gateway", "AWS Lambda", "Amazon CloudFront"
      - "Amazon S3" — label "deployments bucket", caption "manifest per release (files + sha256)"
      - "Amazon DynamoDB" — label "frontend-deployments", caption "current, verified, rolledBackAt"
      - "AWS Lambda" — label "rollback-service", caption "one Lambda for API, Lambda and CloudFront rollbacks"

   b) Region group "us-east-1" (smaller, right):
      - "Amazon CloudWatch" — two alarm chips "cloudfront-frontend-user-4xx-rate", "cloudfront-frontend-user-5xx-rate" (red), plus a small "metrics" chip
      - "Amazon SNS" — label "rollback-notifications"
      - Small note: "CloudFront metrics exist only in us-east-1"

REQUEST FLOW (solid blue arrows, numbered):
 1  Browser → frontend-user-<env>: "HTTPS"
 2  frontend-user-<env> "/*" → site bucket folder "releases/20261006T120000Z": "origin path = live release"
 3  frontend-user-<env> → Browser: "dashboard shows environment + release id"

DASHBOARD FLOW (solid teal arrows, numbered):
 4  Browser → frontend-user-<env> "/api/*": "GET /api/…, never cached"
 5  frontend-user-<env> → dashboard-api: "signed (OAC)"
 6  dashboard-api → read-only box, frontend-deployments and CloudWatch (us-east-1, cross-region arrow): "list + read: APIs, functions, distributions, release history, 24 h metrics"

DEPLOY FLOW (grey dashed arrows, D-numbered):
 D1  GitHub Actions → site bucket: "upload new release releases/20261006T123005Z"
 D2  GitHub Actions → deployments bucket: "store manifest"
 D3  GitHub Actions → frontend-user-<env>-integration: "origin path → new release + invalidate"
 D4  GitHub Actions → frontend-user-<env>-integration: "smoke + browser tests"
 D5  GitHub Actions → frontend-user-<env>: "origin path → same release + invalidate (only if tests pass)"
 D6  GitHub Actions → DynamoDB: "record + mark verified"

ROLLBACK FLOW (solid red arrows, lettered):
 A  frontend-user-<env> → CloudWatch (us-east-1): "4xx / 5xx error rates" (none from the integration distribution)
 B  Alarm → SNS topic (us-east-1) → rollback-service (cross-region arrow): "routed by alarm name: cloudfront"
 C  rollback-service → DynamoDB: "latest release < 30 min old? still live?"
 D  rollback-service → DynamoDB: "target: newest earlier verified release, never rolled back"
 E  rollback-service → DynamoDB: "claim (one rollback for both alarms)"
 F  rollback-service → frontend-user-<env>: "site origin path → previous release + invalidate /* (the /api/* origin is left alone)"
 G  rollback-service → DynamoDB: "record rollback"

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Environments:** the workflows deploy `dev`, then `prod`.
- **Names per environment:**
  - stacks `deploy-aws-cloudfront-<env>` (main region) and the alarms stack in `us-east-1`
  - distributions `frontend-user-<env>` and `frontend-user-<env>-integration`
  - buckets `rollback-factory-demo-<account>-frontend-site-<env>` and `rollback-factory-demo-<account>-frontend-deployments-<env>`
  - table `rollback-factory-demo-frontend-deployments-<env>`
  - dashboard API Lambda `rollback-factory-demo-frontend-dashboard-api-<env>`
  - alarms `rollback-factory-demo-cloudfront-frontend-user-4xx-rate-<env>` and `-5xx-rate-<env>`
  - topics `rollback-factory-demo-rollback-notifications-<env>`, one in the main region and one in `us-east-1`
  - rollback Lambda `rollback-factory-demo-rollback-service-<env>` (the `rollback-service` project, deployed first)
- **Releases:** every build is uploaded once to `releases/<yyyymmddThhmmssZ>/` and never overwritten.
  The origin path of each distribution's site origin selects the release it serves. Both
  distributions read the same bucket.
- **Integration distribution:** CI makes each release live there first and tests it. It has no
  alarms, keeps no release history, and the rollback service never touches it.
- **Dashboard API:** both distributions send `/api/*` to one Lambda, through a function URL that only
  they can call (IAM auth, Origin Access Control). Its answers are never cached. It only reads:
  - API Gateway: the APIs, their stages and deployments
  - Lambda: the functions, their aliases and versions
  - CloudFront: the distributions and their invalidations
  - DynamoDB: the release history of every environment's `frontend-user-<env>`
  - CloudWatch: 24 hours of metrics, the CloudFront ones from `us-east-1`

  It never returns Lambda environment variables or origin custom headers.
- **Release switches** (activation, restore, rollback) change only the site origin's path; the
  function URL origin keeps its own.
- **Regions:** the main stack and the rollback service are in `eu-central-1`. The alarms and an SNS
  topic are in `us-east-1`, because CloudFront publishes its metrics only there; the rollback
  service subscribes to that topic across regions.
- **The page:** the React "AWS Control Center" dashboard. Its Rollback buttons are shown but
  disabled: there is no sign-in yet, so there is no arrow to Cognito.
