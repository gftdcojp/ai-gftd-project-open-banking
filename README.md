# ai-gftd-project-open-banking

> **Open-source core-banking MVP** on Cloudflare Workers + D1.
> Double-entry ledger, DID-addressed accounts, PSD2-style XRPC API.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Status: MVP](https://img.shields.io/badge/status-MVP-orange.svg)]()

A minimal, auditable reference implementation of a bank: **accounts + transfers + transaction history**, with balance always derived from a tamper-evident ledger rather than stored on the account row. Designed to plug into the [AT Protocol](https://atproto.com) / GFTD [W Protocol](https://github.com/gftdcojp) stack but runnable standalone.

## Why

Most "banking API" demos skip the thing that matters: **correctness under concurrency and audit**. This repo is short enough to read in 20 minutes and hard to get wrong:

- **Balance is never stored.** It is `SUM(credit) − SUM(debit)` per account. The ledger is the single source of truth.
- **Transfers are atomic.** Debit + credit rows are written in one D1 `batch()` (SQLite transaction). A partial transfer is impossible.
- **Transfers are idempotent.** Pass `clientRequestId` and retries are safe.
- **Accounts are DIDs.** `did:web:open-banking.gftd.ai:account:{id}` — portable identity, no proprietary IDs.

## API (5 XRPC methods)

All methods live under NSID `ai.gftd.apps.openBanking.*` and are served at `/xrpc/{NSID}` on `open-banking.gftd.ai`.

| NSID | Method | Description |
|---|---|---|
| `createAccount` | `POST` | open an account (checking / savings / custody) |
| `getAccount` | `GET` | account details + derived balance |
| `listAccounts` | `GET` | list an owner's accounts (paginated) |
| `transfer` | `POST` | atomic double-entry transfer between two accounts |
| `listTransactions` | `GET` | ledger view with running balance |

Full schemas: [`lexicons/ai/gftd/apps/openBanking/`](./lexicons/ai/gftd/apps/openBanking).

### Example

```bash
# Open two accounts
curl -X POST https://open-banking.gftd.ai/xrpc/ai.gftd.apps.openBanking.createAccount \
  -H 'content-type: application/json' \
  -d '{"ownerDid":"did:web:alice.example","accountType":"checking","currency":"JPY"}'
# → {"accountDid":"did:web:open-banking.gftd.ai:account:ab12cd34ef","accountNumber":"AB12CD34EF",...}

# Transfer (idempotent)
curl -X POST https://open-banking.gftd.ai/xrpc/ai.gftd.apps.openBanking.transfer \
  -H 'content-type: application/json' \
  -d '{
    "fromAccountDid":"did:web:open-banking.gftd.ai:account:ab12cd34ef",
    "toAccountDid":"did:web:open-banking.gftd.ai:account:xy98zw76vu",
    "amount": 1000,
    "currency":"JPY",
    "clientRequestId":"b3d8...uuid"
  }'
# → {"transactionId":"tx_...","status":"settled","debitEntryId":"...","creditEntryId":"...","fromBalanceAfter":-1000,"toBalanceAfter":1000,...}
```

## Architecture

```
┌──────────────┐   /xrpc/*    ┌─────────────────────┐
│   Client     │ ───────────▶ │  CF Worker (TS)     │
│  (Svelte,    │              │  src/app.ts         │
│   agent,     │              │  - router           │
│   curl)      │              │  - handlers         │
└──────────────┘              │  - derived balance  │
                              └──────────┬──────────┘
                                         │ SQL
                                         ▼
                              ┌─────────────────────┐
                              │  Cloudflare D1      │
                              │  ─ accounts         │
                              │  ─ ledger_entries   │  ← SSoT
                              │  ─ idempotency      │
                              └─────────────────────┘
```

### Schema

```sql
accounts(account_did PK, account_number UNIQUE, owner_did, account_type,
         currency, status, display_name, opened_at)

ledger_entries(entry_id PK, transaction_id, account_did FK, direction ∈ {debit,credit},
               amount > 0, currency, counterparty_did, memo, occurred_at)
-- One transfer = two rows with the same transaction_id.
-- balance(account) = Σ(credit.amount) − Σ(debit.amount)

idempotency(client_request_id PK, transaction_id, response_json, created_at)
```

## Running Locally

```bash
git clone https://github.com/gftdcojp/ai-gftd-project-open-banking
cd ai-gftd-project-open-banking/worker

npm i -g wrangler
wrangler d1 create ai-gftd-open-banking    # copy the returned id into wrangler.jsonc
wrangler dev --local                        # http://127.0.0.1:8787
```

## Deploying

```bash
cd worker
wrangler deploy
```

Route: `open-banking.gftd.ai/*` (adjust `routes` in `wrangler.jsonc` for your zone).

## DoDAF v2 / BPMN / DMN / Forms

This repo ships as a fully **DoDAF v2.02-compliant** architecture description, with executable artefacts:

| DoDAF view | File | Ref |
|---|---|---|
| AV-1 Overview & Summary | [`dodaf/AV-1.json`](./dodaf/AV-1.json) | — |
| OV-1 High-Level Operational Concept | [`dodaf/OV-1.json`](./dodaf/OV-1.json) | — |
| OV-5b Operational Activity Model | [`dodaf/OV-5b.json`](./dodaf/OV-5b.json) | → BPMN |
| OV-6a Operational Rules Model | [`dodaf/OV-6a.json`](./dodaf/OV-6a.json) | → DMN |
| CV-2 Capability Taxonomy | [`dodaf/CV-2.json`](./dodaf/CV-2.json) | — |
| SV-1 Systems Interface Description | [`dodaf/SV-1.json`](./dodaf/SV-1.json) | — |

| BPMN 2.0 process | File | Camunda process key |
|---|---|---|
| Open Account | [`bpmn/open-account.bpmn`](./bpmn/open-account.bpmn) | `openAccount` |
| Transfer | [`bpmn/transfer.bpmn`](./bpmn/transfer.bpmn) | `transfer` |

| DMN 1.3 decision | File | Decision key |
|---|---|---|
| Transfer eligibility | [`dmn/transfer-eligibility.dmn`](./dmn/transfer-eligibility.dmn) | `openBanking.transferEligibility` |

| Camunda form | File | Form key |
|---|---|---|
| Open Account | [`forms/openAccount.form.json`](./forms/openAccount.form.json) | `openBanking.openAccount.v1` |
| Transfer | [`forms/transfer.form.json`](./forms/transfer.form.json) | `openBanking.transfer.v1` |

**Runtime registration**: at cold start the Worker pushes all of the above to the GFTD platform registries via:
- `ai.gftd.dodafv2.deployView` (per DoDAF view)
- `ai.gftd.bpmn.deployProcess` (per BPMN XML)
- `ai.gftd.dmn.evaluate` (inline XML on first decision call)
- `ai.gftd.form.register` (per Camunda form)

See [`worker/src/dodaf-bootstrap.ts`](./worker/src/dodaf-bootstrap.ts). In standalone mode (no `PDS` binding), this is a no-op and the artefacts remain readable via `GET /dodaf`, `GET /forms`, `GET /bpmn/*`, `GET /dmn/*` on the Worker itself.

## Integration with GFTD stack (optional)

In the GFTD monorepo, this app lives at `60-apps/ai-gftd-project-open-banking/` and can be wired to:

- **PDS pipethrough** (`atproto.gftd.ai`) — XRPC calls federate through the shared PDS
- **Auth** (`auth.gftd.ai`) — bearer JWT → caller DID via `AUTH_SERVICE` service binding
- **Design E 3-Tier Write** — large transfers emit an `app.bsky.feed.post` via the PDS commit pipeline (public audit trail)
- **Shannon-optimal identity (ADR-0019)** — accounts are path-based DIDs; no nanoid leaf routing

Standalone mode (this repo) skips all of the above — the Worker is fully self-contained.

## Non-Goals (MVP)

This is a **reference implementation**, not a licensed bank. Out of scope for now:

- PSD2 Strong Customer Authentication (step-up WebAuthn on transfers)
- Interest accrual, holds, overdraft, card/wire/ACH/SWIFT rails, FX
- AML / sanctions / KYC
- Regulatory reporting, statements
- Cross-bank federation

Contributions welcome on any of the above — see [CONTRIBUTING](./CONTRIBUTING.md).

## License

[Apache License 2.0](./LICENSE). Copyright © 2026 gftd.co.jp.
