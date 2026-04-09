import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceQgrepRecoveryAfterRecoverableUpdateFailure,
  beginQgrepExplicitRecovery,
  createEmptyQgrepRecoveryState,
  finalizeSuccessfulQgrepIndexProgress,
  hasQueuedQgrepAutoUpdate,
  isQgrepWorkspaceReadyForToolSearch,
  markQgrepRecoveryDegraded,
  QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS,
  resetQgrepRecoveryState,
  restoreQgrepAutoUpdateQueueAfterFailure,
} from '../qgrepIndexingState';

test('ready check blocks tool search while an auto update is still queued', () => {
  assert.equal(
    isQgrepWorkspaceReadyForToolSearch({
      initialized: true,
      pendingIndexOperationCount: 0,
      autoUpdateInFlight: false,
      startupRefreshPending: false,
      autoUpdateDirty: true,
      managedSearchExcludeDirty: false,
      pendingCreateDeleteCount: 1,
      recoveryPhase: 'idle',
      recoveryAttemptCount: 0,
      warningShownForCurrentFailure: false,
      watchWasRunningBeforeRebuild: false,
      allowExplicitRecovery: false,
      progress: {
        progressKnown: false,
        indexing: false,
      },
    }),
    false,
  );
});

test('ready check blocks tool search while recovery is active even without queued auto update', () => {
  assert.equal(
    isQgrepWorkspaceReadyForToolSearch({
      initialized: true,
      pendingIndexOperationCount: 0,
      autoUpdateInFlight: false,
      startupRefreshPending: false,
      autoUpdateDirty: false,
      managedSearchExcludeDirty: false,
      pendingCreateDeleteCount: 0,
      recoveryPhase: 'retry-update',
      recoveryAttemptCount: 1,
      warningShownForCurrentFailure: false,
      watchWasRunningBeforeRebuild: false,
      allowExplicitRecovery: false,
      progress: {
        progressKnown: true,
        indexing: false,
        progressPercent: 80,
      },
    }),
    false,
  );
});

test('finalizeSuccessfulQgrepIndexProgress promotes a trailing partial frame to complete', () => {
  const next = finalizeSuccessfulQgrepIndexProgress({
    indexedFiles: 123,
    totalFiles: 125,
    remainingFiles: 2,
    progressPercent: 99,
    progressKnown: true,
    indexing: true,
  });

  assert.deepEqual(next, {
    indexedFiles: 123,
    totalFiles: 123,
    remainingFiles: 0,
    progressPercent: 100,
    progressKnown: true,
    indexing: true,
  });
});

test('restoreQgrepAutoUpdateQueueAfterFailure keeps retry intent for the failed batch', () => {
  const next = restoreQgrepAutoUpdateQueueAfterFailure(
    {
      startupRefreshPending: false,
      autoUpdateDirty: false,
      managedSearchExcludeDirty: false,
      pendingCreateDeleteCount: 0,
    },
    3,
    true,
    true,
  );

  assert.equal(hasQueuedQgrepAutoUpdate(next), true);
  assert.deepEqual(next, {
    startupRefreshPending: true,
    autoUpdateDirty: true,
    managedSearchExcludeDirty: true,
    pendingCreateDeleteCount: 3,
  });
});

test('recoverable update failures use two retries before fallback rebuild', () => {
  const first = advanceQgrepRecoveryAfterRecoverableUpdateFailure(
    createEmptyQgrepRecoveryState(),
    'first failure',
  );
  assert.equal(first.action, 'retry-update');
  assert.equal(first.delayMs, QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS[0]);
  assert.equal(first.nextState.recoveryAttemptCount, 1);
  assert.equal(first.nextState.recoveryPhase, 'retry-update');

  const second = advanceQgrepRecoveryAfterRecoverableUpdateFailure(
    first.nextState,
    'second failure',
  );
  assert.equal(second.action, 'retry-update');
  assert.equal(second.delayMs, QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS[1]);
  assert.equal(second.nextState.recoveryAttemptCount, 2);
  assert.equal(second.nextState.recoveryPhase, 'retry-update');

  const third = advanceQgrepRecoveryAfterRecoverableUpdateFailure(
    second.nextState,
    'third failure',
  );
  assert.equal(third.action, 'fallback-rebuild');
  assert.equal(third.delayMs, 0);
  assert.equal(third.nextState.recoveryAttemptCount, 2);
  assert.equal(third.nextState.recoveryPhase, 'fallback-rebuild');
});

test('degraded recoverable state can be restarted by an explicit trigger', () => {
  const degraded = markQgrepRecoveryDegraded(
    {
      ...createEmptyQgrepRecoveryState(),
      recoveryAttemptCount: 2,
      recoveryPhase: 'fallback-rebuild',
    },
    'rebuild failed',
    true,
  );

  const restarted = beginQgrepExplicitRecovery(degraded);
  assert.equal(restarted.recoveryPhase, 'retry-update');
  assert.equal(restarted.recoveryAttemptCount, 0);
  assert.equal(restarted.allowExplicitRecovery, false);
  assert.equal(restarted.lastRecoverableError, 'rebuild failed');
});

test('resetQgrepRecoveryState clears degraded recovery metadata', () => {
  const degraded = markQgrepRecoveryDegraded(
    {
      ...createEmptyQgrepRecoveryState(),
      recoveryAttemptCount: 2,
      warningShownForCurrentFailure: true,
      watchWasRunningBeforeRebuild: true,
    },
    'rebuild failed',
    false,
  );

  assert.deepEqual(resetQgrepRecoveryState(degraded), createEmptyQgrepRecoveryState());
});
