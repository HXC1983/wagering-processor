import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './infrastructure/http/global-exception.filter';

/** Usada pelo main.ts e pelos testes de integração HTTP. */
export async function createApp(logger = true): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, logger ? {} : { logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks(); // fecha o pool do banco em SIGTERM
  return app;
}
