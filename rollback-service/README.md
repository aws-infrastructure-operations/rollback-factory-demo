# rollback-service

One Lambda per environment, `rollback-factory-demo-rollback-service-<env>`, that does the automatic
rollbacks of every project. It picks the **rollback manager from the alarm name**:

```
rollback-factory-demo-<type>-<name>-<env>      type = apigateway | cloudfront | lambda
```

| Type | Manager | Target |
|---|---|---|
| `apigateway` | re-imports the previous verified OpenAPI spec into stage `v1` (skips if the backend Lambda is at fault) | `deploy-aws-api-gateway-<env>`, read from its `RollbackTarget` output |
| `cloudfront` | points `frontend-user-<env>`'s origin path back at the previous verified release and invalidates | `deploy-aws-cloudfront-<env>`, read from its `RollbackTarget` output |
| `lambda` | moves `live` back to the previous version that went live and restores `$LATEST` from its archived zip | functions registered in [`rollback-config.json`](rollback-config.json) |

Alarms of another environment, names outside the convention and non-`ALARM` transitions are skipped.

## Stacks (per environment)

| Stack | Region | Holds |
|---|---|---|
| `rollback-service-us-east-1-<env>` | us-east-1 | topic `rollback-factory-demo-rollback-notifications-<env>` for the CloudFront alarms |
| `rollback-service-<env>` | main region | the same topic for API Gateway and Lambda alarms, the Lambda (subscribed to both topics, cross-region for us-east-1), the scheduled check (every 5 min), the Lambda manager's version archive (table `rollback-factory-demo-lambda-versions-<env>`, bucket `rollback-factory-demo-<account>-lambda-artifacts-<env>`) and its scoped role |

**Deploy this first** in each environment: the projects' alarms publish to its topics, and the
Lambda project's deploy invokes it to sync. `-c alarmEmail=...` subscribes an e-mail to both topics.

## Events

| Event | Sent by | Goes to |
|---|---|---|
| SNS alarm notification | the projects' alarms | the manager named by the alarm type |
| `{ "type": "scheduled-check" }` | EventBridge | Lambda manager: sync, mark stable, re-check alarms still in `ALARM` |
| `{ "type": "sync", "functionName": "<fn>" }` | `deploy-aws-lambda` after promotion, manual Lambda rollbacks | Lambda manager |
| `{ "type": "restore", "manager": "apigateway", "deployedAt": "…" }` | `deploy-aws-api-gateway`: `deployment:restore`, the dashboard | API Gateway manager |
| `{ "type": "restore", "manager": "cloudfront", "deployedAt": "…" }` | the dashboard's CloudFront Restore button | CloudFront manager: switches to that record's release and records a `restore` |
| `{ "type": "point-alias", "functionName": "<fn>", "aliasName": "live", "version": 3 }` | the dashboard's Lambda alias/version menus | Lambda manager: registered functions only. The registered alias moves like a manual rollback by version (alias, `$LATEST` restored, archive updated; a promotion when going forward); any other alias just moves |

Every run logs to `rollback-factory-demo-rollback-service-logs-<env>` and ends with one
`{"msg":"result",...}` (or `{"msg":"failed",...}`) line. Restores and alias moves also log their steps
(`spec-imported`, `stage-redeployed`, `release-switched`, `archive-synced`, `alias-moved`,
`latest-restored`, `recorded`): the dashboard follows them to show a run's progress and log.

## Layout

| Path | Contents |
|---|---|
| `lambda/router.ts` | picks the manager from the alarm name |
| `lambda/targets.ts` | reads a project stack's `RollbackTarget` output |
| `lambda/managers/apigateway/` | API Gateway manager (plan, manager, a copy of the API's deployment records) |
| `lambda/managers/cloudfront/` | CloudFront manager (plan, manager, copies of the frontend's records and release switch) |
| `lambda/managers/lambda/` | Lambda manager (archive/sync, guards, `$LATEST`-only revert, stable marking, scoped credentials) |
| `rollback-config.json` | functions registered with the Lambda manager (`<env>` is replaced) |

The guards and behaviour of each manager are unchanged from when they lived in their projects; see
the project READMEs and story files.

## Workflow

[`rollback-service.yml`](../.github/workflows/rollback-service.yml): PR checks (typecheck, unit tests,
synth); on `main`, dev → testing → staging → prod through
[`rollback-service-deploy.yml`](../.github/workflows/rollback-service-deploy.yml): deploy → integration
tests (routing and skip paths only, safe everywhere) → next environment.
