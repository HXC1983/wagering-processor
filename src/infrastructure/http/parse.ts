import type { MoneyProps } from '../../shared/domain/money';
import { isUuid } from '../../shared/domain/uuid';
import { InvalidRequestError } from './errors';

export function asObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} deve ser um objeto JSON`);
  }
  return value as Record<string, unknown>;
}

export function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`campo obrigatório ausente ou inválido: ${key}`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`campo inválido: ${key}`);
  }
  return value;
}

/** O valor monetário só é aceito como string (um number JSON é rejeitado). */
export function parseMoney(value: unknown, field: string): MoneyProps {
  const source = asObject(value, field);
  return { amount: requireString(source, 'amount'), currency: requireString(source, 'currency') };
}

export function requireUuidParam(value: string, name: string): string {
  if (!isUuid(value)) {
    throw new InvalidRequestError(`${name} deve ser um UUID válido`);
  }
  return value;
}

/** Parâmetro de query opcional: precisa ser uma string não vazia. */
export function optionalQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw new InvalidRequestError(`${name} inválido`);
  }
  return value;
}

export function parseLimit(value: unknown, fallback = 50, max = 200): number {
  const text = optionalQuery(value, 'limit');
  if (text === undefined) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(text)) {
    throw new InvalidRequestError('limit deve ser um inteiro positivo');
  }
  const limit = Number(text);
  if (limit < 1 || limit > max) {
    throw new InvalidRequestError(`limit deve estar entre 1 e ${max}`);
  }
  return limit;
}
