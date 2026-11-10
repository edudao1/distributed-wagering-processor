import { Migration } from "@mikro-orm/migrations";

export class Migration20261109000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_balance_non_negative check (balance_amount >= 0),
        constraint ck_wallets_version_positive check (version >= 1)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(100) not null,
        external_transaction_id varchar(200) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id varchar(200) not null,
        game_id varchar(200) not null,
        kind varchar(16) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(200),
        reference_transaction_id uuid,
        status varchar(24) not null,
        failure_code varchar(64),
        observed_balance_amount numeric(20,2),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        updated_at timestamptz not null,
        constraint fk_wager_transactions_wallet foreign key (wallet_id)
          references wallets (id) deferrable initially deferred,
        constraint fk_wager_transactions_reference foreign key (reference_transaction_id)
          references wager_transactions (id) deferrable initially deferred,
        constraint uq_wager_transactions_idempotency_key unique (idempotency_key),
        constraint uq_wager_transactions_provider_external unique (provider_id, external_transaction_id),
        constraint ck_wager_transactions_kind
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint ck_wager_transactions_status
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint ck_wager_transactions_amount
          check (amount >= 0 and (kind = 'LOSS' or amount > 0)),
        constraint ck_wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_transactions_failure_code
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint ck_wager_transactions_terminal_timestamp
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint ck_wager_transactions_pending_schedule
          check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null),
        constraint ck_wager_transactions_observed_balance
          check (observed_balance_amount is null or observed_balance_amount >= 0),
        constraint ck_wager_transactions_attempts check (reference_attempts >= 0)
      )`);

    this.addSql(`
      create unique index uq_wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`);
    this.addSql(`
      create index ix_wager_transactions_reference_lookup
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null`);
    this.addSql(`
      create index ix_wager_transactions_pending_reference
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index ix_wager_transactions_wallet on wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(6) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        created_at timestamptz not null,
        constraint uq_ledger_seq unique (seq),
        constraint uq_ledger_transaction unique (transaction_id),
        constraint uq_ledger_wallet_transaction unique (wallet_id, transaction_id),
        constraint fk_ledger_wallet foreign key (wallet_id)
          references wallets (id) deferrable initially deferred,
        constraint fk_ledger_transaction foreign key (transaction_id)
          references wager_transactions (id) deferrable initially deferred,
        constraint ck_ledger_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint ck_ledger_amount_positive check (amount > 0),
        constraint ck_ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ck_ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      )`);
    this.addSql(`create index ix_ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(100) not null,
        message_id varchar(200) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id varchar(200) not null,
        event_type varchar(100) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        locked_by varchar(200),
        locked_until timestamptz,
        last_error text,
        constraint ck_outbox_attempts check (attempts >= 0)
      )`);
    this.addSql(`
      create index ix_outbox_pending
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null`);

    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% is append-only', tg_table_name using errcode = '55000';
      end
      $$`);

    this.addSql(`
      create trigger trg_ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation()`);
    this.addSql(`
      create trigger trg_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation()`);
    this.addSql(`
      create trigger trg_wager_transactions_no_delete
        before delete on wager_transactions
        for each row execute function forbid_mutation()`);

    this.addSql(`
      create function ledger_entry_chain() returns trigger language plpgsql as $$
      declare
        previous_balance numeric(20,2);
      begin
        select balance_after into previous_balance
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by seq desc
         limit 1;
        if coalesce(previous_balance, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: expected balance_before %, got %',
            new.wallet_id, coalesce(previous_balance, 0), new.balance_before
            using errcode = '23514';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger trg_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function ledger_entry_chain()`);

    this.addSql(`
      create function enforce_wallet_update() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'immutable columns of wallet % cannot change', old.id using errcode = '55000';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallet % balance changed without incrementing version', old.id using errcode = '23514';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallet % version changed without a balance change', old.id using errcode = '23514';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger trg_wallets_update
        before update on wallets
        for each row execute function enforce_wallet_update()`);

    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        last_balance numeric(20,2);
      begin
        select balance_after into last_balance
          from wallet_ledger_entries
         where wallet_id = new.id
         order by seq desc
         limit 1;
        if coalesce(last_balance, 0) <> new.balance_amount then
          raise exception 'wallet % balance % diverges from ledger %',
            new.id, new.balance_amount, coalesce(last_balance, 0)
            using errcode = '23514';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger trg_wallets_match_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function assert_wallet_matches_ledger()`);

    this.addSql(`
      create function enforce_wager_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % is terminal (%)', old.id, old.status using errcode = '55000';
        end if;
        if new.id <> old.id or new.provider_id <> old.provider_id
           or new.external_transaction_id <> old.external_transaction_id
           or new.idempotency_key <> old.idempotency_key or new.payload_hash <> old.payload_hash
           or new.wallet_id <> old.wallet_id or new.player_id <> old.player_id
           or new.round_id <> old.round_id or new.game_id <> old.game_id
           or new.kind <> old.kind or new.amount <> old.amount or new.currency <> old.currency
           or new.created_at <> old.created_at
           or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id then
          raise exception 'immutable columns of transaction % cannot change', old.id using errcode = '55000';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger trg_wager_transactions_update
        before update on wager_transactions
        for each row execute function enforce_wager_transaction_update()`);

    this.addSql(`
      create function assert_transaction_ledger_consistency() returns trigger language plpgsql as $$
      declare
        matching integer;
        total integer;
      begin
        select count(*) filter (where wallet_id = new.wallet_id), count(*)
          into matching, total
          from wallet_ledger_entries
         where transaction_id = new.id;
        if new.status = 'PROCESSED' and new.kind <> 'LOSS' then
          if matching <> 1 or total <> 1 then
            raise exception 'processed transaction % must have exactly one ledger entry on its wallet', new.id
              using errcode = '23514';
          end if;
        elsif total <> 0 then
          raise exception 'transaction % (%/%) must not have ledger entries', new.id, new.kind, new.status
            using errcode = '23514';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger trg_wager_transactions_ledger_consistency
        after insert or update on wager_transactions
        deferrable initially deferred
        for each row execute function assert_transaction_ledger_consistency()`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists assert_transaction_ledger_consistency()`);
    this.addSql(`drop function if exists enforce_wager_transaction_update()`);
    this.addSql(`drop function if exists assert_wallet_matches_ledger()`);
    this.addSql(`drop function if exists enforce_wallet_update()`);
    this.addSql(`drop function if exists ledger_entry_chain()`);
    this.addSql(`drop function if exists forbid_mutation()`);
  }
}
