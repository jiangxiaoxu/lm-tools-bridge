export interface RetryQgrepClearRemovalContext {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RetryQgrepClearRemovalOptions {
  delaysMs?: readonly number[];
  onRetry?: (context: RetryQgrepClearRemovalContext) => void | Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

const RETRYABLE_QGREP_CLEAR_ERROR_CODES = new Set<string>(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);
const DEFAULT_QGREP_CLEAR_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000];
const DEFAULT_QGREP_CLEAR_FAILURE_DETAILS_LIMIT = 2;

export function isRetryableQgrepClearError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && RETRYABLE_QGREP_CLEAR_ERROR_CODES.has(code);
}

export async function retryQgrepClearRemoval(
  operation: () => Promise<void>,
  options: RetryQgrepClearRemovalOptions = {},
): Promise<void> {
  const delaysMs = options.delaysMs ?? DEFAULT_QGREP_CLEAR_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isRetryableQgrepClearError(error) || attempt >= delaysMs.length) {
        throw error;
      }
      const delayMs = delaysMs[attempt]!;
      attempt += 1;
      await options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

export function buildQgrepClearFailureWarningMessage(
  summaryMessage: string,
  failures: readonly string[],
  maxDetails = DEFAULT_QGREP_CLEAR_FAILURE_DETAILS_LIMIT,
): string {
  if (failures.length === 0) {
    return summaryMessage;
  }
  const normalizedLimit = Math.max(1, maxDetails);
  const details = failures
    .slice(0, normalizedLimit)
    .map((failure) => failure.replace(/: Error:\s*/u, ': ').trim())
    .join(' | ');
  const remaining = failures.length - normalizedLimit;
  return remaining > 0
    ? `${summaryMessage} Failures: ${details} | +${String(remaining)} more.`
    : `${summaryMessage} Failures: ${details}`;
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  });
}
