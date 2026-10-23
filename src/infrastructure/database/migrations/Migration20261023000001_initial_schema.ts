import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000001 extends Migration {
  override async up(): Promise<void> {
    // ---------- wallets ----------
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer NOT NULL DEFAULT 1,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive_ck CHECK (version >= 1)
      )
    `);

    // ---------- wager_transactions ----------
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      text NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets (id),
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            text NOT NULL,
        failure_code                      text,
        resulting_balance                 numeric(19,2),
        reference_attempts                integer NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_ck CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_non_negative_ck CHECK (amount >= 0),
        CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_reference_required_ck CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_tx_failure_code_ck CHECK (
          status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL
        ),
        CONSTRAINT wager_tx_attempts_non_negative_ck CHECK (reference_attempts >= 0)
      )
    `);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK processado).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED'
          AND kind IN ('REFUND','ROLLBACK')
          AND reference_transaction_id IS NOT NULL
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id)`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    // Estados terminais são imutáveis e nada é excluído.
    this.addSql(`
      CREATE FUNCTION protect_wager_transactions() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions nao permite DELETE';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transacao em estado terminal (%) e imutavel', OLD.status;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_protect
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_wager_transactions()
    `);

    // ---------- wallet_ledger_entries ----------
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id             uuid NOT NULL UNIQUE,
        wallet_id      uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        direction      text NOT NULL,
        amount         numeric(19,2) NOT NULL,
        currency       char(3) NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after  numeric(19,2) NOT NULL,
        created_at     timestamptz NOT NULL,
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )
    `);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`);

    // O ledger nunca é sobrescrito nem excluído (nem truncado).
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries e imutavel: % nao e permitido', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable_rows
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation()
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation()
    `);

    // ---------- inbox ----------
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  text NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // ---------- outbox ----------
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    uuid NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_attempts_non_negative_ck CHECK (attempts >= 0)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_ledger_mutation()`);
    this.addSql(`DROP FUNCTION IF EXISTS protect_wager_transactions()`);
  }
}
