import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidRequestError } from '../../infrastructure/http/errors';
import {
  asObject,
  optionalString,
  parseMoney,
  requireString,
  requireUuidParam,
} from '../../infrastructure/http/parse';
import { WAGER_TRANSACTION_READER } from '../../infrastructure/tokens';
import { TransactionNotFoundError } from '../application/errors';
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../application/process-wager-transaction.use-case';
import type { WagerTransactionReader } from '../application/wager-transaction-reader';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { toTransactionView } from './views';

/** Rejeição de negócio = 422; aceita com pendência = 202; primeira vez = 201; replay = 200. */
function statusFor(result: ProcessWagerTransactionResult): number {
  if (result.status === WagerTransactionStatus.Rejected) {
    return 422;
  }
  if (result.status === WagerTransactionStatus.PendingReference) {
    return 202;
  }
  return result.idempotentReplay ? 200 : 201;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(WAGER_TRANSACTION_READER) private readonly transactions: WagerTransactionReader,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new InvalidRequestError('o header Idempotency-Key é obrigatório');
    }
    const input = asObject(body);
    const command: ProcessWagerTransactionCommand = {
      providerId: requireString(input, 'providerId'),
      externalTransactionId: requireString(input, 'externalTransactionId'),
      idempotencyKey: idempotencyKey.trim(),
      playerId: requireString(input, 'playerId'),
      walletId: requireString(input, 'walletId'),
      roundId: requireString(input, 'roundId'),
      gameId: requireString(input, 'gameId'),
      kind: requireString(input, 'kind') as WagerTransactionKind,
      money: parseMoney(input.money, 'money'),
      referenceExternalTransactionId: optionalString(input, 'referenceExternalTransactionId'),
      correlationId: correlationId?.trim() || undefined,
    };

    const result = await this.processTransaction.execute(command);
    res.status(statusFor(result)).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const tx = await this.transactions.findById(requireUuidParam(transactionId, 'transactionId'));
    if (!tx) {
      throw new TransactionNotFoundError(`transação não encontrada: ${transactionId}`);
    }
    return toTransactionView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(
        `transação não encontrada: ${providerId}/${externalTransactionId}`,
      );
    }
    return toTransactionView(tx);
  }
}
