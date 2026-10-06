# FE-07: 4xx / 5xx error-rate alarms + SNS (us-east-1)

**Story requirement:** 10 (4xx and 5xx error-rate alarms, optional SNS notification)
**Depends on:** FE-02
**Branch:** `feature/frontend-alarms`

## Goal

Two CloudFront error-rate alarms in the us-east-1 alarms stack, with actions that can be turned on
or off and that notify an SNS topic.

## Scope

- **Alarms stack** (`rollback-factory-demo-frontend-alarms-<env>`, us-east-1). It gets the
  distribution ID from the main stack through `crossRegionReferences`.
- **Alarms:**
  - `rollback-factory-demo-frontend-4xx-rate-<env>`: `AWS/CloudFront` `4xxErrorRate`
  - `rollback-factory-demo-frontend-5xx-rate-<env>`: `AWS/CloudFront` `5xxErrorRate`
  - dimensions `DistributionId`, `Region=Global`, 1-minute period
  - **Low-traffic guard**, like the API: metric math `IF(requests >= minRequests, rate, 0)` using
    `Requests`, so a few intentional 404s from the smoke test can't fire it.
  - Defaults: 4xx above 25 % with ≥ 20 requests, 5xx above 5 % with ≥ 5 requests, 2 of 3 periods,
    missing data `notBreaching`. All values in `config.alarms`.
- **SNS topic** `rollback-factory-demo-frontend-notifications-<env>`:
  - `enforceSSL: true` **plus an explicit topic-policy allow for `cloudwatch.amazonaws.com`**,
    or alarm actions fail (see the API)
  - `-c alarmNotifications=false` removes the alarm actions; `-c alarmEmail=...` adds an e-mail subscription
- **Outputs:** `Alarm4xxName`, `Alarm5xxName`, `AlarmTopicArn`.
- **Unit tests:** metric, dimensions, thresholds, math expression, topic policy, actions on/off.

## Acceptance criteria

- Synth shows both alarms in us-east-1 on the right distribution.
- With notifications on, `aws cloudwatch set-alarm-state --state-value ALARM` on dev publishes to the
  topic (visible in the e-mail subscription or topic metrics).
- With `alarmNotifications=false`, the alarms have no actions.

## Notes

- CloudFront's `4xxErrorRate` / `5xxErrorRate` are percentages, and CloudFront publishes them with a
  delay of a few minutes. Expect a rollback to start roughly 3–6 minutes after the errors begin.
- Additional CloudFront metrics (per-status-code rates) cost extra and are not needed.
