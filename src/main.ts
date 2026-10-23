import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3000));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
