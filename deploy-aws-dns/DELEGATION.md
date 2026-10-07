# Delegating rollback.ionuteliantudor.com

The zone `rollback.ionuteliantudor.com` is deployed by this project in account 860193728768.
The parent zone `ionuteliantudor.com` lives in **another AWS account**. Until the parent points
`rollback` at this zone's name servers:

- the frontend's certificates stay *Pending validation* (the deploy waits on them);
- the sites' domains don't resolve (`ENOTFOUND` in the integration tests).

Current zone:

| | |
|---|---|
| Hosted zone id | `Z0085229C3Q59CDL7JTH` (`HOSTED_ZONE` in [`deploy-aws-cloudfront/lib/config.ts`](../deploy-aws-cloudfront/lib/config.ts)) |
| Name servers | `ns-518.awsdns-00.net`, `ns-381.awsdns-47.com`, `ns-1039.awsdns-01.org`, `ns-1893.awsdns-44.co.uk` |

If the zone is ever deleted and redeployed, it gets a **new id and new name servers**. Take them
from the [`dns`](../.github/workflows/dns.yml) run summary, then update this file, `HOSTED_ZONE`,
and the NS record below.

## 1. Add the NS record (other account)

Route 53 → Hosted zones → **ionuteliantudor.com** → **Create record**

| Field | Value |
|---|---|
| Record name | `rollback` (the console appends `.ionuteliantudor.com`) |
| Record type | `NS` (not CNAME) |
| TTL | `300` |
| Value (one per line) | see below |

```
ns-518.awsdns-00.net
ns-381.awsdns-47.com
ns-1039.awsdns-01.org
ns-1893.awsdns-44.co.uk
```

- Use the zone the domain actually uses. Its NS record lists `ns-376.awsdns-47.com`,
  `ns-806.awsdns-36.net`, `ns-1075.awsdns-06.org` and `ns-1702.awsdns-20.co.uk`.
- If a `rollback` NS record already exists with other servers, edit it and replace its values.
- Remove any ACM validation CNAMEs under `rollback` from the parent zone (`_….dev.rollback…`).
  Once `rollback` is delegated, the parent's records under it are ignored. This zone holds the
  validation records itself.

## 2. Check it

```sh
# the parent zone's own name server: answers right away
nslookup -type=NS rollback.ionuteliantudor.com ns-376.awsdns-47.com
# a public resolver: up to ~15 minutes while caches drop the old "does not exist" answer
nslookup -type=NS rollback.ionuteliantudor.com 8.8.8.8
```

Both should list the four name servers above. An answer of `Non-existent domain` from the first
query means the record isn't in the parent zone the domain uses.

## 3. Deploy the frontend

Run [`frontend.yml`](../.github/workflows/frontend.yml) (or merge a change to
`deploy-aws-cloudfront`). The certificate validates through the delegated zone, usually within a
few minutes. The sites are then served on:

| Distribution | Domain |
|---|---|
| `frontend-user-dev` | https://dev.rollback.ionuteliantudor.com |
| `frontend-user-dev-integration` | https://dev-integration.rollback.ionuteliantudor.com |
| `frontend-user-prod` | https://rollback.ionuteliantudor.com |
| `frontend-user-prod-integration` | https://integration.rollback.ionuteliantudor.com |

## Teardown order

Destroy the frontend stacks (`cleanup.yml`) **before** deleting the zone. The frontend stack
deletes its alias records in this zone. If the zone is gone first, the stack ends in
`DELETE_FAILED`, its distributions stay up, and the certificate stays in use. To recover, delete
the stack again and retain the four `*Alias*` record resources.
