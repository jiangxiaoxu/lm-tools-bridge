export interface QgrepAutoUpdateQueueState {
  startupRefreshPending: boolean;
  autoUpdateDirty: boolean;
  managedSearchExcludeDirty: boolean;
  pendingCreateDeleteCount: number;
}

export const QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS = [1000, 5000] as const;

export type QgrepRecoveryPhase = 'idle' | 'retry-update' | 'fallback-rebuild' | 'degraded';

export interface QgrepRecoveryState {
  recoveryPhase: QgrepRecoveryPhase;
  recoveryAttemptCount: number;
  lastRecoverableError?: string;
  warningShownForCurrentFailure: boolean;
  watchWasRunningBeforeRebuild: boolean;
  allowExplicitRecovery: boolean;
}

export interface QgrepWorkspaceIndexProgressState {
  indexedFiles?: number;
  totalFiles?: number;
  remainingFiles?: number;
  progressPercent?: number;
  progressKnown: boolean;
  indexing: boolean;
}

export interface QgrepWorkspaceToolReadinessState extends QgrepAutoUpdateQueueState, QgrepRecoveryState {
  initialized: boolean;
  pendingIndexOperationCount: number;
  autoUpdateInFlight: boolean;
  progress: QgrepWorkspaceIndexProgressState;
}

export interface QgrepRecoveryDecision {
  action: 'retry-update' | 'fallback-rebuild';
  delayMs: number;
  nextState: QgrepRecoveryState;
}

export function createEmptyQgrepRecoveryState(): QgrepRecoveryState {
  return {
    recoveryPhase: 'idle',
    recoveryAttemptCount: 0,
    warningShownForCurrentFailure: false,
    watchWasRunningBeforeRebuild: false,
    allowExplicitRecovery: false,
  };
}

export function hasQueuedQgrepAutoUpdate(state: QgrepAutoUpdateQueueState): boolean {
  return state.startupRefreshPending || state.autoUpdateDirty || state.managedSearchExcludeDirty;
}

export function isQgrepRecoveryActive(state: Pick<QgrepRecoveryState, 'recoveryPhase'>): boolean {
  return state.recoveryPhase !== 'idle';
}

export function isQgrepWorkspaceReadyForToolSearch(state: QgrepWorkspaceToolReadinessState): boolean {
  if (!state.initialized) {
    return false;
  }
  if (state.pendingIndexOperationCount > 0) {
    return false;
  }
  if (state.autoUpdateInFlight) {
    return false;
  }
  if (isQgrepRecoveryActive(state)) {
    return false;
  }
  if (hasQueuedQgrepAutoUpdate(state)) {
    return false;
  }
  if (state.progress.indexing) {
    return false;
  }
  if (state.progress.progressKnown) {
    const percent = state.progress.progressPercent ?? 0;
    return percent >= 100;
  }
  return true;
}

export function finalizeSuccessfulQgrepIndexProgress(
  progress: QgrepWorkspaceIndexProgressState,
): QgrepWorkspaceIndexProgressState {
  const indexedFiles = progress.indexedFiles;
  if (indexedFiles === undefined || !Number.isInteger(indexedFiles) || indexedFiles < 0) {
    return progress;
  }
  if (
    progress.totalFiles === indexedFiles
    && progress.remainingFiles === 0
    && progress.progressPercent === 100
    && progress.progressKnown
  ) {
    return progress;
  }
  return {
    ...progress,
    totalFiles: indexedFiles,
    remainingFiles: 0,
    progressPercent: 100,
    progressKnown: true,
  };
}

export function resetQgrepRecoveryState(state: QgrepRecoveryState): QgrepRecoveryState {
  return {
    ...createEmptyQgrepRecoveryState(),
  };
}

export function beginQgrepExplicitRecovery(state: QgrepRecoveryState): QgrepRecoveryState {
  return {
    ...state,
    recoveryPhase: 'retry-update',
    recoveryAttemptCount: 0,
    allowExplicitRecovery: false,
  };
}

export function advanceQgrepRecoveryAfterRecoverableUpdateFailure(
  state: QgrepRecoveryState,
  errorSummary: string,
): QgrepRecoveryDecision {
  const nextAttempt = state.recoveryAttemptCount + 1;
  if (nextAttempt <= QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS.length) {
    return {
      action: 'retry-update',
      delayMs: QGREP_UPDATE_RECOVERY_RETRY_DELAYS_MS[nextAttempt - 1],
      nextState: {
        ...state,
        recoveryPhase: 'retry-update',
        recoveryAttemptCount: nextAttempt,
        lastRecoverableError: errorSummary,
        warningShownForCurrentFailure: false,
        allowExplicitRecovery: false,
      },
    };
  }

  return {
    action: 'fallback-rebuild',
    delayMs: 0,
    nextState: {
      ...state,
      recoveryPhase: 'fallback-rebuild',
      lastRecoverableError: errorSummary,
      warningShownForCurrentFailure: false,
      allowExplicitRecovery: false,
    },
  };
}

export function markQgrepRecoveryDegraded(
  state: QgrepRecoveryState,
  errorSummary: string,
  allowExplicitRecovery: boolean,
): QgrepRecoveryState {
  return {
    ...state,
    recoveryPhase: 'degraded',
    lastRecoverableError: errorSummary,
    warningShownForCurrentFailure: false,
    allowExplicitRecovery,
  };
}

export function restoreQgrepAutoUpdateQueueAfterFailure(
  state: QgrepAutoUpdateQueueState,
  queuedCount: number,
  shouldSyncManagedSearchExclude: boolean,
  isStartupRefreshRun: boolean,
): QgrepAutoUpdateQueueState {
  return {
    startupRefreshPending: state.startupRefreshPending || isStartupRefreshRun,
    autoUpdateDirty: true,
    managedSearchExcludeDirty: state.managedSearchExcludeDirty || shouldSyncManagedSearchExclude,
    pendingCreateDeleteCount: Math.max(state.pendingCreateDeleteCount, queuedCount),
  };
}
