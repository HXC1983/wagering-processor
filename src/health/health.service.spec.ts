import { describe, expect, test } from 'bun:test';
import { HealthService } from './health.service';

const up = (name: string) => ({ name, check: async () => undefined });
const down = (name: string) => ({
  name,
  check: async () => {
    throw new Error('sem conexão');
  },
});

describe('HealthService', () => {
  test('live sempre responde ok', () => {
    expect(new HealthService([]).live()).toEqual({ status: 'ok' });
  });

  test('ready com todas as dependências no ar', async () => {
    const result = await new HealthService([up('postgres'), up('sqs')]).ready();
    expect(result).toEqual({ ok: true, checks: { postgres: 'up', sqs: 'up' } });
  });

  test('ready indica qual dependência caiu', async () => {
    const result = await new HealthService([up('postgres'), down('sqs')]).ready();
    expect(result).toEqual({ ok: false, checks: { postgres: 'up', sqs: 'down' } });
  });
});
