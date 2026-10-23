import { EntitySchema } from '@mikro-orm/core';

/**
 * Mapeamento por EntitySchema (sem decorators): o domínio permanece puro e não
 * depende de metadados de ORM, nem do suporte a decorators do runtime.
 * O schema real (constraints, índices, triggers) vem da migration.
 */

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string; // numeric(19,2) em string: exato, sem ponto flutuante
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    playerId: { type: 'string', columnType: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'number', columnType: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultingBalance: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'text', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', columnType: 'text', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', columnType: 'text', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', columnType: 'text', fieldName: 'payload_hash' },
    walletId: { type: 'string', columnType: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', columnType: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', columnType: 'text', fieldName: 'round_id' },
    gameId: { type: 'string', columnType: 'text', fieldName: 'game_id' },
    kind: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'string',
      columnType: 'text',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'string',
      columnType: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', columnType: 'text', fieldName: 'failure_code', nullable: true },
    resultingBalance: {
      type: 'string',
      columnType: 'numeric(19,2)',
      fieldName: 'resulting_balance',
      nullable: true,
    },
    referenceAttempts: { type: 'number', columnType: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_reference_attempt_at',
      nullable: true,
    },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true },
  },
});

export interface LedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

// A coluna "seq" (identity) é gerada pelo banco e fica fora do mapeamento de escrita.
export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  name: 'LedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    walletId: { type: 'string', columnType: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'string', columnType: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'string', columnType: 'numeric(19,2)', fieldName: 'balance_before' },
    balanceAfter: { type: 'string', columnType: 'numeric(19,2)', fieldName: 'balance_after' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});

export interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: 'OutboxRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'string', columnType: 'uuid', primary: true },
    aggregateId: { type: 'string', columnType: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', columnType: 'text', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'number', columnType: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'published_at', nullable: true },
  },
});

export interface InboxRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRow>({
  name: 'InboxRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'text', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', columnType: 'text', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', columnType: 'text', fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'processed_at', nullable: true },
  },
});

export const allSchemas = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxSchema, InboxSchema];
