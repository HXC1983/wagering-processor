export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  pollMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`timeout (${timeoutMs}ms) aguardando: ${what}`);
}
