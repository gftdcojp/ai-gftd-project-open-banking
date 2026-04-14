# ADR-0001: Double-Entry Ledger + Derived Balance

**Status**: Accepted (2026-04-15)
**Context**: MVP

## Decision

The single source of truth for every account's balance is the `ledger_entries` table. Balances are **never stored** on `accounts` rows. Every balance read is a `SUM(credit) − SUM(debit)` aggregate.

Every transfer writes **exactly two rows** — one `debit` on the source account and one `credit` on the destination account — sharing a single `transaction_id`, inside one D1 `batch()` (atomic SQLite transaction).

## Rationale

1. **Tamper evidence.** A stored balance can be silently edited. A ledger exposes any tampering as an arithmetic inconsistency.
2. **No race conditions on balance.** Under concurrent transfers, a stored `accounts.balance` needs row-level locking or CAS. Derived balance just needs the ledger insert to be atomic — which D1 guarantees via `batch()`.
3. **Audit trail for free.** `listTransactions` is a direct projection of the ledger; no separate journal / event log.
4. **Schema is tiny.** Three tables, no triggers, no materialized views.

## Consequences

- **Read cost grows O(entries).** Mitigated per-account by an index on `(account_did, occurred_at DESC)`. When an account has millions of entries, introduce a cached snapshot (`balance_snapshots`) — this is a future optimization, not an MVP concern.
- **No hot-path writes to `accounts`.** `accounts` rows are effectively append-once metadata.
- **Must enforce `amount > 0`.** Signs live in `direction`. A negative `amount` would double-book.

## Alternatives Considered

- **Stored balance with CAS.** Works but requires either a distributed lock or retry-on-conflict logic. Harder to audit.
- **Event-sourced projection (separate write model / read model).** Appropriate at much larger scale; overkill for MVP.

## Invariants (checkable offline)

1. For every `transaction_id`: `Σ(debit.amount) == Σ(credit.amount)` and `count(direction='debit') == count(direction='credit')`.
2. For every account with `status='closed'`: derived balance `== 0`.
3. `amount > 0` for every ledger entry (CHECK constraint).

A periodic job (future) should assert these and alarm on violation.
