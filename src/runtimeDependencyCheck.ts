import { spawn } from 'node:child_process';

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
export const NODE_WINGET_PACKAGE_ID = 'OpenJS.NodeJS.LTS';
export const INSTALL_WITH_WINGET_ACTION = 'Install with winget';
export const DOWNLOAD_NODE_ACTION = 'Download Node.js';
export const DISMISS_ACTION = 'Dismiss';
const COMMAND_PROBE_TIMEOUT_MS = 5000;

export interface CommandProbeResult {
  available: boolean;
  reason: 'available' | 'missing' | 'timeout' | 'exit-code';
  detail?: string;
}

export interface LaunchCommandSpec {
  command: string;
  args: string[];
}

export interface RuntimeDependencyCheckOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probeCommand?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CommandProbeResult>;
  launchDetachedCommand?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
  showWarningMessage: (message: string, actions: readonly string[]) => Promise<string | undefined>;
  showErrorMessage: (message: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}

let startupCheckPromise: Promise<void> | undefined;
let startupPromptShown = false;

/**
 * Ensure the startup dependency prompt runs at most once per extension-host lifetime.
 *
 * @param options Runtime services and environment adapters.
 * @returns A promise that settles after the check path completes or is skipped.
 */
export function ensureNodeRuntimeAvailableOnStartup(options: RuntimeDependencyCheckOptions): Promise<void> {
  if (startupCheckPromise) {
    return startupCheckPromise;
  }
  startupCheckPromise = runNodeRuntimeAvailabilityCheck(options).finally(() => {
    startupCheckPromise = undefined;
  });
  return startupCheckPromise;
}

/**
 * Reset module-level startup state for deterministic tests.
 *
 * @returns Nothing.
 */
export function resetNodeRuntimeAvailabilityStateForTests(): void {
  startupCheckPromise = undefined;
  startupPromptShown = false;
}

/**
 * Probe a command by executing it with a short timeout.
 *
 * @param command Command name to resolve through PATH.
 * @param args Command arguments.
 * @param env Environment variables for the child process.
 * @param timeoutMs Maximum runtime before the probe is treated as timed out.
 * @returns Availability status plus failure reason when unavailable.
 */
export async function probeCommandAvailability(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandProbeResult> {
  return await new Promise<CommandProbeResult>((resolve) => {
    let settled = false;
    const child = spawn(command, [...args], {
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        available: false,
        reason: 'timeout',
      });
    }, timeoutMs);
    const finish = (result: CommandProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', (error) => {
      const nodeError = error as NodeJS.ErrnoException;
      finish({
        available: false,
        reason: nodeError.code === 'ENOENT' ? 'missing' : 'exit-code',
        detail: error.message,
      });
    });
    child.once('exit', (code, signal) => {
      finish(code === 0
        ? {
          available: true,
          reason: 'available',
        }
        : {
          available: false,
          reason: 'exit-code',
          detail: signal ? `signal:${signal}` : `exit:${String(code ?? 'null')}`,
        });
    });
  });
}

/**
 * Build the detached external PowerShell launch command for the Node.js winget install flow.
 *
 * @returns The command and arguments that should be passed to spawn().
 */
export function buildWingetInstallLaunchSpec(): LaunchCommandSpec {
  return {
    command: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'start',
      '"LM Tools Bridge Node.js Installer"',
      'powershell.exe',
      '-NoLogo',
      '-NoExit',
      '-Command',
      `winget install --id ${NODE_WINGET_PACKAGE_ID} -e --accept-package-agreements --accept-source-agreements`,
    ],
  };
}

async function runNodeRuntimeAvailabilityCheck(options: RuntimeDependencyCheckOptions): Promise<void> {
  try {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32') {
      return;
    }

    const env = options.env ?? process.env;
    const probeCommand = options.probeCommand ?? probeCommandAvailability;
    const launchDetachedCommand = options.launchDetachedCommand ?? launchDetachedProcess;
    const nodeProbe = await probeCommand('node', ['--version'], env, COMMAND_PROBE_TIMEOUT_MS);
    if (nodeProbe.available) {
      options.logger?.info?.('Detected external Node.js runtime on PATH.');
      return;
    }

    const wingetProbe = await probeCommand('winget', ['--version'], env, COMMAND_PROBE_TIMEOUT_MS);
    options.logger?.warn?.(`External Node.js runtime is unavailable (${formatProbeFailure(nodeProbe)}).`);
    if (startupPromptShown) {
      return;
    }
    startupPromptShown = true;

    const actions = wingetProbe.available
      ? [INSTALL_WITH_WINGET_ACTION, DOWNLOAD_NODE_ACTION, DISMISS_ACTION]
      : [DOWNLOAD_NODE_ACTION, DISMISS_ACTION];
    const selection = await safelyShowWarningMessage(
      options,
      'LM Tools Bridge requires Node.js on PATH to run the synced stdio manager. Install Node.js LTS, then restart VS Code.',
      actions,
    );

    if (selection === INSTALL_WITH_WINGET_ACTION) {
      try {
        const launchSpec = buildWingetInstallLaunchSpec();
        await launchDetachedCommand(launchSpec.command, launchSpec.args, env);
        options.logger?.info?.(`Launched external winget install for package '${NODE_WINGET_PACKAGE_ID}'.`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.error?.(`Failed to launch winget install: ${message}`);
        await safelyShowErrorMessage(
          options,
          'Failed to launch the external winget installer. Download Node.js manually, then restart VS Code.',
        );
        return;
      }
    }

    if (selection === DOWNLOAD_NODE_ACTION) {
      try {
        await options.openExternal(NODE_DOWNLOAD_URL);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.error?.(`Failed to open the Node.js download page: ${message}`);
        await safelyShowErrorMessage(
          options,
          'Failed to open the Node.js download page. Open https://nodejs.org/en/download manually, then restart VS Code.',
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error?.(`Node.js dependency startup check failed: ${message}`);
  }
}

function formatProbeFailure(result: CommandProbeResult): string {
  if (result.detail && result.detail.trim().length > 0) {
    return `${result.reason}: ${result.detail}`;
  }
  return result.reason;
}

async function launchDetachedProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function safelyShowWarningMessage(
  options: RuntimeDependencyCheckOptions,
  message: string,
  actions: readonly string[],
): Promise<string | undefined> {
  try {
    return await options.showWarningMessage(message, actions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger?.error?.(`Failed to show the Node.js dependency warning: ${detail}`);
    return undefined;
  }
}

async function safelyShowErrorMessage(
  options: RuntimeDependencyCheckOptions,
  message: string,
): Promise<void> {
  try {
    await options.showErrorMessage(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger?.error?.(`Failed to show the Node.js dependency error message: ${detail}`);
  }
}
