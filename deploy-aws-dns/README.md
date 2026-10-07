# deploy-aws-dns

The Route 53 hosted zone **`rollback.ionuteliantudor.com`**, shared by every environment's CloudFront
sites ([`deploy-aws-cloudfront`](../deploy-aws-cloudfront)).

| Distribution | Domain |
|---|---|
| `frontend-user-dev` | `dev.rollback.ionuteliantudor.com` |
| `frontend-user-dev-integration` | `dev-integration.rollback.ionuteliantudor.com` |
| `frontend-user-prod` | `rollback.ionuteliantudor.com` |
| `frontend-user-prod-integration` | `integration.rollback.ionuteliantudor.com` |

(`siteDomains()` in [`lib/config.ts`](lib/config.ts).) The frontend stacks add the records to this
zone: their certificates' validation records and an alias record per site.

## Why a project of its own

One stack, `deploy-aws-dns`, for all environments. The cleanup workflow destroys an environment with
`cdk destroy --all`: if the zone were in the frontend's app, destroying dev would take the zone prod
uses. It is not part of [`cleanup.yml`](../.github/workflows/cleanup.yml), and the zone is **kept**
even if the stack is deleted, so its name servers (and the delegation to them) never change.

Cost: $0.50 a month for the zone, plus DNS queries.

## Delegating the zone (one time)

`ionuteliantudor.com`'s DNS is hosted elsewhere. After the first deploy, the run summary of the
[`dns`](../.github/workflows/dns.yml) workflow (and the stack's `NameServers` output) lists four name
servers. At `ionuteliantudor.com`'s DNS host, add **one NS record**:

| Name | Type | Values |
|---|---|---|
| `rollback` | NS | the four name servers, e.g. `ns-123.awsdns-45.com` |

Then check it (it can take from minutes to a few hours, depending on the host):

```sh
dig NS rollback.ionuteliantudor.com +short
```

Do this **before** deploying the frontend with its domains: their certificates are validated through
this zone, and the deploy waits until they are.

Put the stack's `HostedZoneId` output into `deploy-aws-cloudfront/lib/config.ts` (`HOSTED_ZONE_ID`).

## CI

[`.github/workflows/dns.yml`](../.github/workflows/dns.yml): typecheck, tests and synth on pull
requests; on `main` (or by hand) it deploys with the `prod` GitHub environment's credentials (same
account as dev).

```sh
npm ci
npm test
npx cdk deploy            # with credentials for the account
```
