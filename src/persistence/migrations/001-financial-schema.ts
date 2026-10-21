/** SQL explícito: constraints e índices são parte do contrato, não schema sync. */
export const migration001 = {
  id: '001-financial-schema',
  up: `
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance numeric NOT NULL CHECK (balance >= 0 AND balance < 1e28 AND scale(balance) <= 2),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, currency),
  UNIQUE (id, player_id, currency)
);
CREATE TABLE wager_transactions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
  external_transaction_id text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  wallet_id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount numeric NOT NULL CHECK (amount >= 0 AND amount < 1e28 AND scale(amount) <= 2),
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  reference_external_transaction_id text,
  reference_transaction_id uuid REFERENCES wager_transactions(id),
  failure_code text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
  next_attempt_at timestamptz,
  FOREIGN KEY (wallet_id, player_id, currency) REFERENCES wallets(id, player_id, currency),
  UNIQUE (provider_id, external_transaction_id),
  UNIQUE (idempotency_key),
  UNIQUE (id, wallet_id, currency),
  CHECK (kind = 'LOSS' OR amount > 0),
  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CHECK (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL),
  CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)
);
CREATE UNIQUE INDEX wager_reversal_once ON wager_transactions(reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE UNIQUE INDEX wager_opening_once ON wager_transactions(wallet_id) WHERE kind = 'OPENING';
CREATE INDEX wager_reference_due ON wager_transactions(next_attempt_at, id)
  WHERE status = 'PENDING_REFERENCE';
CREATE TABLE wallet_ledger_entries (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount numeric NOT NULL CHECK (amount > 0 AND amount < 1e28 AND scale(amount) <= 2),
  currency text NOT NULL,
  balance_before numeric NOT NULL CHECK (balance_before >= 0 AND balance_before < 1e28 AND scale(balance_before) <= 2),
  balance_after numeric NOT NULL CHECK (balance_after >= 0 AND balance_after < 1e28 AND scale(balance_after) <= 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
  UNIQUE (transaction_id, wallet_id),
  CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
);
CREATE INDEX ledger_wallet_cursor ON wallet_ledger_entries(wallet_id, created_at, id);
CREATE FUNCTION protect_ledger() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'ledger is immutable' USING ERRCODE = '23514';
END;
$body$;
CREATE TRIGGER ledger_no_changes BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION protect_ledger();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION protect_ledger();
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  result jsonb,
  PRIMARY KEY (consumer_name, message_id)
);
CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_due ON outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;
`,
  down: `
DROP TABLE outbox_messages;
DROP TABLE inbox_messages;
DROP TABLE wallet_ledger_entries;
DROP FUNCTION protect_ledger();
DROP TABLE wager_transactions;
DROP TABLE wallets;
`,
};
