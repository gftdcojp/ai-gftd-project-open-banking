# Contributing

Thanks for considering a contribution! This repo is an MVP and PRs are welcome.

## Ground rules

- **Correctness > features.** A fix to an invariant (see [ADR-0001](./docs/ADR-0001-double-entry-derived-balance.md)) beats any new endpoint.
- **Keep it one file.** `worker/src/app.ts` is intentionally a single file. Split only when it crosses ~800 lines and the boundary is obvious (e.g. an auth adapter).
- **No stored balances.** Balances are always derived from `ledger_entries`. PRs that add a `balance` column will be closed.
- **Amount is always positive.** Sign lives in `direction`.

## Good first issues

- PSD2-style SCA step-up on `transfer` (WebAuthn)
- Holds / authorized-but-not-settled state
- Interest accrual scheduled job
- AML screening hook (interface + stub provider)
- `closeAccount` NSID with invariant check (balance == 0)
- Property-based tests with `fast-check` for the ledger invariants

## Dev loop

```bash
cd worker
npm i
npm run typecheck
npm run dev
```

## License

By contributing you agree your work is licensed under Apache-2.0.
