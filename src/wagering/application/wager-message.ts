import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { hashPayload } from './payload-hash';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.use-case';

/** Mensagem que nunca poderá ser processada (formato, tipo ou campo inválido). */
export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageFormatError';
  }
}

export interface ParsedWagerMessage {
  messageId: string;
  payloadHash: string;
  command: ProcessWagerTransactionCommand;
}

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MessageFormatError(`${field} deve ser um objeto`);
  }
  return value as Record<string, unknown>;
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MessageFormatError(`campo obrigatório ausente ou inválido: ${key}`);
  }
  return value;
}

function optionalText(source: Record<string, unknown>, key: string): string | undefined {
  return source[key] === undefined || source[key] === null ? undefined : text(source, key);
}

export function parseWagerTransactionRequested(body: string): ParsedWagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MessageFormatError('o corpo da mensagem não é um JSON válido');
  }

  const envelope = record(json, 'mensagem');
  const messageId = text(envelope, 'messageId');
  const type = text(envelope, 'type');
  if (type !== WAGER_MESSAGE_TYPE) {
    throw new MessageFormatError(`tipo de mensagem não suportado: ${type}`);
  }

  const data = record(envelope.data, 'data');
  const kind = text(data, 'kind');
  if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)) {
    throw new MessageFormatError(`kind inválido: ${kind}`);
  }
  const money = record(data.money, 'data.money');

  return {
    messageId,
    // Hash do conteúdo de negócio (sem messageId e occurredAt): a mesma mensagem reenviada gera o mesmo hash.
    payloadHash: hashPayload({ type, data }),
    command: {
      providerId: text(data, 'providerId'),
      externalTransactionId: text(data, 'externalTransactionId'),
      idempotencyKey: text(data, 'idempotencyKey'),
      playerId: text(data, 'playerId'),
      walletId: text(data, 'walletId'),
      roundId: text(data, 'roundId'),
      gameId: text(data, 'gameId'),
      kind: kind as WagerTransactionKind,
      // amount só é aceito como string: um number JSON vira MessageFormatError.
      money: { amount: text(money, 'amount'), currency: text(money, 'currency') },
      referenceExternalTransactionId: optionalText(data, 'referenceExternalTransactionId'),
      correlationId: messageId,
    },
  };
}
