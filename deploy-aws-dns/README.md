# deploy-aws-dns

The Route 53 hosted zone **`rollback.ionuteliantudor.com`**, shared by every environment's CloudFront
sites ([`deploy-aws-cloudfront`](../deploy-aws-cloudfront)), and the API Gateway custom domains every
API of an environment is mapped on.

| Distribution | Domain |
|---|---|
| `frontend-user-dev` | `dev.rollback.ionuteliantudor.com` |
| `frontend-user-dev-integration` | `dev-integration.rollback.ionuteliantudor.com` |
| `frontend-user-prod` | `rollback.ionuteliantudor.com` |
| `frontend-user-prod-integration` | `integration.rollback.ionuteliantudor.com` |

(`siteDomains()` in [`lib/config.ts`](lib/config.ts).) The frontend stacks add the records to this
zone: their certificates' validation records and an alias record per site.

## API domains

Stack `deploy-aws-dns-api-domains`: one API Gateway custom domain per environment (`apiDomain()` in
[`lib/config.ts`](lib/config.ts)), each with its DNS-validated certificate and A/AAAA alias records in
the zone.

| Environment | API domain |
|---|---|
| dev | `api.dev.rollback.ionuteliantudor.com` |
| prod | `api.rollback.ionuteliantudor.com` |

The domains hold no mappings: each API's stack maps its stages on them as `<api path>/<stage>`, e.g.
`api.dev.rollback…/user/v1` → `api-user-dev`, stage `v1` ([`deploy-aws-api-gateway`](../deploy-aws-api-gateway#custom-domain)).
They are regional with TLS 1.2, which multi-level mappings need, and a regional domain only serves
APIs of its own region: deploy this stack in the APIs' region (CI uses `vars.AWS_REGION`).

## Why a project of its own

Two stacks, `deploy-aws-dns` (the zone) and `deploy-aws-dns-api-domains`, for all environments. The cleanup workflow destroys an environment with
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

Step by step, with the current name servers: [`DELEGATION.md`](DELEGATION.md).

Its `HostedZoneId` (`Z0085229C3Q59CDL7JTH`) is `HOSTED_ZONE` in `deploy-aws-cloudfront/lib/config.ts`.

## CI

[`.github/workflows/dns.yml`](../.github/workflows/dns.yml): typecheck, tests and synth on pull
requests; on `main` (or by hand) it deploys with the `prod` GitHub environment's credentials (same
account as dev).

```sh
npm ci
npm test
npx cdk deploy --all      # with credentials for the account, in the APIs' region
```
