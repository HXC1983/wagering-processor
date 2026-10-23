import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves de objetos em ordem alfabética, valores undefined omitidos,
 * sem espaços. O mesmo conteúdo de negócio sempre gera a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 (hex) do JSON canônico. Só os campos de negócio entram; o header de idempotência não. */
export function hashPayload(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
