# Architecture diagram prompt (frontend-user)

A prompt for an image model (e.g. ChatGPT) that draws the `frontend-user` architecture: the two
CloudFront distributions in front of the private release bucket, the integration-first deploy and
the alarm-driven rollback in us-east-1. It follows [`lib/`](../lib), the rollback Lambda in
[`lambda/rollback/`](../lambda/rollback) and the `frontend*.yml` workflows. Update it when those change.

Image models tend to garble long labels, so the prompt keeps labels short and puts details in a
legend. If the picture comes out cluttered, ask for two images: one with the request and deploy
flows, and one with only the rollback flow (A–G).

## Prompt

```text
Create a clean, professional AWS architecture diagram (landscape, 16:9, white background) using official AWS Architecture Icons and AWS group styles. Use short, exactly spelled labels — no invented text, no lorem ipsum. Number the arrows of the request flow (1–3), the deploy flow (D1–D6) and the rollback flow (A–G), and add a small legend explaining them.

TITLE: "frontend-user — versioned releases on CloudFront with alarm-driven rollback (rollback-factory-demo)"

LAYOUT (left to right):

1) LEFT — "Clients"
   - "Browser" (user icon)
   - "GitHub Actions" (GitHub logo) with a small vertical pipeline next to it:
     "dev → testing → staging → prod". Inside one environment show the steps:
     "build → upload release → integration distribution → tests → live distribution → record"

2) CENTER — an "AWS Cloud" group with TWO region groups side by side:

   a) Region group "eu-central-1" (larger, left):
      - "Amazon CloudFront" — label "frontend-user-<env>" (green, "live")
      - "Amazon CloudFront" — label "frontend-user-<env>-integration" (blue, "tests only"), below it
      - "Amazon S3" — label "site bucket (private)" with three small folder tiles inside:
          "releases/20261006T110000Z", "releases/20261006T120000Z", "releases/20261006T123005Z"
      - Small lock icons on the arrows from both distributions to the bucket, caption "Origin Access Control"
      - "Amazon S3" — label "deployments bucket", caption "manifest per release (files + sha256)"
      - "Amazon DynamoDB" — label "frontend-deployments", caption "current, verified, rolledBackAt"

   b) Region group "us-east-1" (smaller, right):
      - "Amazon CloudWatch" — two alarm chips "frontend-4xx-rate", "frontend-5xx-rate" (red)
      - "Amazon SNS" — label "frontend-notifications topic"
      - "AWS Lambda" — label "frontend-rollback"
      - Small note: "CloudFront metrics exist only in us-east-1"

REQUEST FLOW (solid blue arrows, numbered):
 1  Browser → frontend-user-<env>: "HTTPS"
 2  frontend-user-<env> → site bucket folder "releases/20261006T120000Z": "origin path = live release"
 3  frontend-user-<env> → Browser: "page shows environment + release id"

DEPLOY FLOW (grey dashed arrows, D-numbered):
 D1  GitHub Actions → site bucket: "upload new release releases/20261006T123005Z"
 D2  GitHub Actions → deployments bucket: "store manifest"
 D3  GitHub Actions → frontend-user-<env>-integration: "origin path → new release + invalidate"
 D4  GitHub Actions → frontend-user-<env>-integration: "smoke + browser tests"
 D5  GitHub Actions → frontend-user-<env>: "origin path → same release + invalidate (only if tests pass)"
 D6  GitHub Actions → DynamoDB: "record + mark verified"

ROLLBACK FLOW (solid red arrows, lettered):
 A  frontend-user-<env> → CloudWatch (us-east-1): "4xx / 5xx error rates" (none from the integration distribution)
 B  Alarm → SNS topic → frontend-rollback
 C  frontend-rollback → DynamoDB (cross-region arrow): "latest release < 30 min old? still live?"
 D  frontend-rollback → DynamoDB: "target: newest earlier verified release, never rolled back"
 E  frontend-rollback → DynamoDB: "claim (one rollback for both alarms)"
 F  frontend-rollback → frontend-user-<env> (cross-region arrow): "origin path → previous release + invalidate /*"
 G  frontend-rollback → DynamoDB: "record rollback"

STYLE: flat AWS icon style, thin lines, rounded group borders, consistent spacing, readable sans-serif font, no 3D, no gradients, no shadows. Keep every label exactly as written above.
```

## Reference

What the diagram should show, in case the model misses or invents something:

- **Names per environment:**
  - distributions `frontend-user-<env>` and `frontend-user-<env>-integration`
  - buckets `rollback-factory-demo-<account>-frontend-site-<env>` and `rollback-factory-demo-<account>-frontend-deployments-<env>`
  - table `rollback-factory-demo-frontend-deployments-<env>`
  - alarms `rollback-factory-demo-frontend-4xx-rate-<env>` and `-5xx-rate-<env>`
  - topic `rollback-factory-demo-frontend-notifications-<env>`
  - rollback Lambda `rollback-factory-demo-frontend-rollback-<env>`
- **Releases:** every build is uploaded once to `releases/<yyyymmddThhmmssZ>/` and never overwritten.
  Each distribution's origin path selects the release it serves. Both read the same bucket.
- **Integration distribution:** CI makes each release live there first and tests it. It has no
  alarms, and the rollback Lambda never touches it.
- **Regions:** the main stack is in `eu-central-1`. The alarms, topic and rollback Lambda are in
  `us-east-1`, because CloudFront publishes its metrics only there. The rollback Lambda writes to the
  table in `eu-central-1`.
- **The page:** a simple static page showing the environment and release id. Sign-in and calling
  the API are out of scope for now, so there is no arrow to Cognito or the API.
