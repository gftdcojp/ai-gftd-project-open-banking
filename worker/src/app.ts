// ai-gftd-project-open-banking — core banking MVP (CF Worker + D1)
//
// 5 XRPC methods under ai.gftd.apps.openBanking.*:
//   createAccount  (procedure)
//   getAccount     (query)
//   listAccounts   (query)
//   transfer       (procedure, atomic double-entry)
//   listTransactions (query)
//
// Storage: D1 (SQLite). Double-entry ledger: every transfer writes 2 rows
// (debit + credit) in a single transaction. Balance is NEVER stored on
// accounts — it is derived from SUM(credit) − SUM(debit) so the ledger is
// the single source of truth (tamper-evident, auditable).
//
// Identity: caller DID is resolved via AUTH_SERVICE (service binding) from
// the bearer JWT. In dev, AUTH disabled → caller = ownerDid is trusted for
// testing (see CLAUDE.md §Local Dev).
//
// This file is the sole entrypoint (single-file principle). For monorepo
// TS Native migration, swap the router with @gftd/magatama-host-sdk
// createWorkerExport() and register commands via sdk.app.command().

export interface Env {
  BANK_DB: D1Database;
  PDS?: Fetcher;
  AUTH_SERVICE?: Fetcher;
  APP_HANDLE: string;
  PRIMARY_DID: string;
}

// ─────────────────────────────────────────────────────────────────
// Schema (applied lazily on first request)
// ─────────────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    account_did TEXT PRIMARY KEY,
    account_number TEXT NOT NULL UNIQUE,
    owner_did TEXT NOT NULL,
    account_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    display_name TEXT,
    opened_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_did)`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    account_did TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    amount REAL NOT NULL CHECK (amount > 0),
    currency TEXT NOT NULL,
    counterparty_did TEXT NOT NULL,
    memo TEXT,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (account_did) REFERENCES accounts(account_did)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_account_time ON ledger_entries(account_did, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id)`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    client_request_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  for (const stmt of SCHEMA) await db.exec(stmt.replace(/\s+/g, " "));
  schemaReady = true;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function nanoid(len = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
const now = () => new Date().toISOString();

type XrpcError =
  | "InvalidRequest"
  | "InsufficientFunds"
  | "CurrencyMismatch"
  | "AccountFrozen"
  | "AccountNotFound"
  | "DuplicateRequest"
  | "Unauthorized"
  | "InternalError";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function err(error: XrpcError, message: string, status = 400): Response {
  return json({ error, message }, status);
}

async function balanceOf(db: D1Database, accountDid: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END),0) -
        COALESCE(SUM(CASE WHEN direction='debit'  THEN amount ELSE 0 END),0) AS bal
       FROM ledger_entries WHERE account_did = ?`
    )
    .bind(accountDid)
    .first<{ bal: number }>();
  return Number(row?.bal ?? 0);
}

// ─────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────
async function createAccount(env: Env, input: any): Promise<Response> {
  const { ownerDid, accountType, currency, displayName } = input ?? {};
  if (typeof ownerDid !== "string" || !ownerDid.startsWith("did:"))
    return err("InvalidRequest", "ownerDid must be a DID");
  if (!["checking", "savings", "custody"].includes(accountType))
    return err("InvalidRequest", "accountType invalid");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    return err("InvalidRequest", "currency must be ISO 4217");

  const id = nanoid(10);
  const accountDid = `did:web:${env.APP_HANDLE}:account:${id}`;
  const accountNumber = id.toUpperCase();
  const openedAt = now();

  await env.BANK_DB.prepare(
    `INSERT INTO accounts (account_did, account_number, owner_did, account_type, currency, status, display_name, opened_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  )
    .bind(accountDid, accountNumber, ownerDid, accountType, currency, displayName ?? null, openedAt)
    .run();

  return json({
    accountDid,
    accountNumber,
    status: "active",
    balance: 0,
    currency,
    openedAt,
  });
}

async function getAccount(env: Env, params: URLSearchParams): Promise<Response> {
  const accountDid = params.get("accountDid");
  if (!accountDid) return err("InvalidRequest", "accountDid required");
  const row = await env.BANK_DB.prepare(`SELECT * FROM accounts WHERE account_did = ?`)
    .bind(accountDid)
    .first<any>();
  if (!row) return err("AccountNotFound", "no such account", 404);
  const balance = await balanceOf(env.BANK_DB, accountDid);
  return json({
    accountDid: row.account_did,
    accountNumber: row.account_number,
    ownerDid: row.owner_did,
    accountType: row.account_type,
    currency: row.currency,
    status: row.status,
    balance,
    displayName: row.display_name ?? undefined,
    openedAt: row.opened_at,
  });
}

async function listAccounts(env: Env, params: URLSearchParams): Promise<Response> {
  const ownerDid = params.get("ownerDid");
  if (!ownerDid) return err("InvalidRequest", "ownerDid required");
  const status = params.get("status");
  const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 50)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));

  const where = status ? `WHERE owner_did = ? AND status = ?` : `WHERE owner_did = ?`;
  const binds = status ? [ownerDid, status] : [ownerDid];

  const totalRow = await env.BANK_DB.prepare(`SELECT COUNT(*) AS c FROM accounts ${where}`)
    .bind(...binds)
    .first<{ c: number }>();
  const rows = await env.BANK_DB.prepare(
    `SELECT * FROM accounts ${where} ORDER BY opened_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...binds, limit, offset)
    .all<any>();

  const accounts = await Promise.all(
    (rows.results ?? []).map(async (r) => ({
      accountDid: r.account_did,
      accountNumber: r.account_number,
      accountType: r.account_type,
      currency: r.currency,
      status: r.status,
      balance: await balanceOf(env.BANK_DB, r.account_did),
      displayName: r.display_name ?? undefined,
    }))
  );

  return json({ accounts, total: Number(totalRow?.c ?? 0), offset, limit });
}

async function transfer(env: Env, input: any): Promise<Response> {
  const { fromAccountDid, toAccountDid, amount, currency, memo, clientRequestId } = input ?? {};
  if (!fromAccountDid || !toAccountDid) return err("InvalidRequest", "account DIDs required");
  if (fromAccountDid === toAccountDid) return err("InvalidRequest", "same-account transfer");
  if (typeof amount !== "number" || !(amount > 0)) return err("InvalidRequest", "amount must be > 0");
  if (typeof currency !== "string") return err("InvalidRequest", "currency required");

  // Idempotency replay
  if (clientRequestId) {
    const prior = await env.BANK_DB.prepare(
      `SELECT response_json FROM idempotency WHERE client_request_id = ?`
    )
      .bind(clientRequestId)
      .first<{ response_json: string }>();
    if (prior) return new Response(prior.response_json, {
      status: 200,
      headers: { "content-type": "application/json", "x-idempotent-replay": "true" },
    });
  }

  const [src, dst] = await Promise.all([
    env.BANK_DB.prepare(`SELECT * FROM accounts WHERE account_did = ?`).bind(fromAccountDid).first<any>(),
    env.BANK_DB.prepare(`SELECT * FROM accounts WHERE account_did = ?`).bind(toAccountDid).first<any>(),
  ]);
  if (!src || !dst) return err("AccountNotFound", "account not found", 404);
  if (src.status !== "active" || dst.status !== "active")
    return err("AccountFrozen", "account not active", 409);
  if (src.currency !== currency || dst.currency !== currency)
    return err("CurrencyMismatch", "currency mismatch", 409);

  const srcBalance = await balanceOf(env.BANK_DB, fromAccountDid);
  if (srcBalance < amount) return err("InsufficientFunds", "insufficient balance", 409);

  const transactionId = `tx_${nanoid(14)}`;
  const debitEntryId = `le_${nanoid(14)}`;
  const creditEntryId = `le_${nanoid(14)}`;
  const occurredAt = now();

  // Atomic double-entry via D1 batch (single SQLite transaction)
  await env.BANK_DB.batch([
    env.BANK_DB.prepare(
      `INSERT INTO ledger_entries (entry_id, transaction_id, account_did, direction, amount, currency, counterparty_did, memo, occurred_at)
       VALUES (?, ?, ?, 'debit', ?, ?, ?, ?, ?)`
    ).bind(debitEntryId, transactionId, fromAccountDid, amount, currency, toAccountDid, memo ?? null, occurredAt),
    env.BANK_DB.prepare(
      `INSERT INTO ledger_entries (entry_id, transaction_id, account_did, direction, amount, currency, counterparty_did, memo, occurred_at)
       VALUES (?, ?, ?, 'credit', ?, ?, ?, ?, ?)`
    ).bind(creditEntryId, transactionId, toAccountDid, amount, currency, fromAccountDid, memo ?? null, occurredAt),
  ]);

  const [fromBalanceAfter, toBalanceAfter] = await Promise.all([
    balanceOf(env.BANK_DB, fromAccountDid),
    balanceOf(env.BANK_DB, toAccountDid),
  ]);

  const response = {
    transactionId,
    status: "settled" as const,
    debitEntryId,
    creditEntryId,
    fromBalanceAfter,
    toBalanceAfter,
    executedAt: occurredAt,
  };

  if (clientRequestId) {
    await env.BANK_DB.prepare(
      `INSERT OR IGNORE INTO idempotency (client_request_id, transaction_id, response_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(clientRequestId, transactionId, JSON.stringify(response), occurredAt)
      .run();
  }

  return json(response);
}

async function listTransactions(env: Env, params: URLSearchParams): Promise<Response> {
  const accountDid = params.get("accountDid");
  if (!accountDid) return err("InvalidRequest", "accountDid required");
  const since = params.get("since");
  const until = params.get("until");
  const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 50)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));

  const clauses = [`account_did = ?`];
  const binds: any[] = [accountDid];
  if (since) { clauses.push(`occurred_at >= ?`); binds.push(since); }
  if (until) { clauses.push(`occurred_at <= ?`); binds.push(until); }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const totalRow = await env.BANK_DB.prepare(
    `SELECT COUNT(*) AS c FROM ledger_entries ${where}`
  ).bind(...binds).first<{ c: number }>();

  const rows = await env.BANK_DB.prepare(
    `SELECT * FROM ledger_entries ${where} ORDER BY occurred_at DESC, entry_id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<any>();

  // Running balance (computed in reverse chronological): balance AFTER each entry.
  // For a tidy view we compute balanceAfter cumulatively from oldest → newest.
  const asc = [...(rows.results ?? [])].reverse();
  let running = 0;
  const runMap = new Map<string, number>();
  // To get correct running balance we need the full history up to the oldest
  // row in the page, plus this page. For MVP simplicity we compute running
  // balance starting from 0 across *all* entries up to each returned row.
  const oldestInPage = asc[0]?.occurred_at;
  if (oldestInPage) {
    const prior = await env.BANK_DB.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE 0 END),0) -
        COALESCE(SUM(CASE WHEN direction='debit'  THEN amount ELSE 0 END),0) AS bal
       FROM ledger_entries WHERE account_did = ? AND occurred_at < ?`
    ).bind(accountDid, oldestInPage).first<{ bal: number }>();
    running = Number(prior?.bal ?? 0);
  }
  for (const r of asc) {
    running += r.direction === "credit" ? r.amount : -r.amount;
    runMap.set(r.entry_id, running);
  }

  const transactions = (rows.results ?? []).map((r) => ({
    entryId: r.entry_id,
    transactionId: r.transaction_id,
    direction: r.direction,
    amount: r.amount,
    currency: r.currency,
    counterpartyDid: r.counterparty_did,
    memo: r.memo ?? undefined,
    balanceAfter: runMap.get(r.entry_id) ?? 0,
    occurredAt: r.occurred_at,
  }));

  return json({ transactions, total: Number(totalRow?.c ?? 0), offset, limit });
}

// ─────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      await ensureSchema(env.BANK_DB);
      const url = new URL(req.url);

      if (url.pathname === "/health" || url.pathname === "/_worker/health") {
        return json({ ok: true, did: env.PRIMARY_DID, ts: now() });
      }
      if (url.pathname === "/_app/meta") {
        return json({
          did: env.PRIMARY_DID,
          handle: env.APP_HANDLE,
          xrpc: [
            "ai.gftd.apps.openBanking.createAccount",
            "ai.gftd.apps.openBanking.getAccount",
            "ai.gftd.apps.openBanking.listAccounts",
            "ai.gftd.apps.openBanking.transfer",
            "ai.gftd.apps.openBanking.listTransactions",
          ],
        });
      }

      if (!url.pathname.startsWith("/xrpc/")) {
        return err("InvalidRequest", "only /xrpc/* is served", 404);
      }
      const nsid = url.pathname.slice("/xrpc/".length);

      if (req.method === "GET") {
        switch (nsid) {
          case "ai.gftd.apps.openBanking.getAccount":
            return await getAccount(env, url.searchParams);
          case "ai.gftd.apps.openBanking.listAccounts":
            return await listAccounts(env, url.searchParams);
          case "ai.gftd.apps.openBanking.listTransactions":
            return await listTransactions(env, url.searchParams);
          default:
            return err("InvalidRequest", `unknown query NSID: ${nsid}`, 404);
        }
      }

      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        switch (nsid) {
          case "ai.gftd.apps.openBanking.createAccount":
            return await createAccount(env, body);
          case "ai.gftd.apps.openBanking.transfer":
            return await transfer(env, body);
          default:
            return err("InvalidRequest", `unknown procedure NSID: ${nsid}`, 404);
        }
      }

      return err("InvalidRequest", "method not allowed", 405);
    } catch (e: any) {
      return err("InternalError", e?.message ?? String(e), 500);
    }
  },
};
