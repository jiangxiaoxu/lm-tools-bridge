import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildQgrepClearFailureWarningMessage,
  isRetryableQgrepClearError,
  retryQgrepClearRemoval,
} from '../qgrepClear';

test('isRetryableQgrepClearError accepts Windows lock-style filesystem codes', () => {
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']) {
    const error = Object.assign(new Error(`${code} failure`), { code }) as NodeJS.ErrnoException;
    assert.equal(isRetryableQgrepClearError(error), true);
  }
});

test('isRetryableQgrepClearError rejects unrelated errors', () => {
  const error = Object.assign(new Error('ENOENT failure'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
  assert.equal(isRetryableQgrepClearError(error), false);
  assert.equal(isRetryableQgrepClearError(new Error('plain error')), false);
});

test('retryQgrepClearRemoval retries retryable errors and then succeeds', async () => {
  const delays: number[] = [];
  let calls = 0;

  await retryQgrepClearRemoval(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' }) as NodeJS.ErrnoException;
      }
    },
    {
      delaysMs: [10, 20, 30],
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('retryQgrepClearRemoval does not retry non-retryable errors', async () => {
  let calls = 0;

  await assert.rejects(
    retryQgrepClearRemoval(
      async () => {
        calls += 1;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      },
      {
        delaysMs: [10, 20],
        sleep: async () => undefined,
      },
    ),
    /missing/u,
  );

  assert.equal(calls, 1);
});

test('buildQgrepClearFailureWarningMessage appends normalized workspace failures', () => {
  const message = buildQgrepClearFailureWarningMessage(
    'Qgrep index directory cleared for 1/2 workspace(s), 1 failed.',
    ["UE5: Error: EBUSY: resource busy or locked, unlink 'E:/Foo/workspace.qgd_'"],
  );

  assert.equal(
    message,
    "Qgrep index directory cleared for 1/2 workspace(s), 1 failed. Failures: UE5: EBUSY: resource busy or locked, unlink 'E:/Foo/workspace.qgd_'",
  );
});

test('buildQgrepClearFailureWarningMessage caps rendered failure details', () => {
  const message = buildQgrepClearFailureWarningMessage(
    'Qgrep index directory cleared for 1/3 workspace(s), 2 failed.',
    [
      'UE5: Error: EBUSY: locked',
      'Game: Error: EPERM: denied',
      'Tools: Error: EACCES: denied',
    ],
    2,
  );

  assert.equal(
    message,
    'Qgrep index directory cleared for 1/3 workspace(s), 2 failed. Failures: UE5: EBUSY: locked | Game: EPERM: denied | +1 more.',
  );
});
