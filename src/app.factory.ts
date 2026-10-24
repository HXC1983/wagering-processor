import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './infrastructure/http/global-exception.filter';
import { requestContext } from './infrastructure/http/request-context.middleware';
import { jsonLog } from './shared/infrastructure/logger';

/** Usada pelo main.ts e pelos testes de integração HTTP. */
export async function createApp(logger = true): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, logger ? {} : { logger: false });
  const logRequests = logger && process.env.NODE_ENV !== 'test';
  app.use(requestContext(logRequests ? jsonLog : () => undefined));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks(); // fecha o pool do banco em SIGTERM
  return app;
}
