import * as vscode from 'vscode';

export const CONFIG_SECTION = 'lmToolsBridge';
export const CONFIG_USE_WORKSPACE_SETTINGS = 'useWorkspaceSettings';

let workspaceSettingWarningEmitted = false;
let warnLogger: ((message: string) => void) | undefined;

export function setConfigurationWarningLogger(logger: (message: string) => void): void {
  warnLogger = logger;
}

export function getConfigurationResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function isWorkspaceSettingsEnabled(resource?: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const inspection = config.inspect<boolean>(CONFIG_USE_WORKSPACE_SETTINGS);
  const workspaceValue = inspection?.workspaceFolderValue ?? inspection?.workspaceValue;
  if (workspaceValue === true) {
    return true;
  }
  if (!workspaceSettingWarningEmitted && inspection?.globalValue === true) {
    workspaceSettingWarningEmitted = true;
    const logger = warnLogger ?? console.warn;
    logger('lmToolsBridge.useWorkspaceSettings is set in User settings but is only honored in Workspace settings.');
  }
  return false;
}

export async function resolveToolsConfigTarget(resource?: vscode.Uri): Promise<vscode.ConfigurationTarget> {
  if (!isWorkspaceSettingsEnabled(resource)) {
    return vscode.ConfigurationTarget.Global;
  }
  if (vscode.workspace.workspaceFile) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.ConfigurationTarget.Workspace;
}

export function getConfigValue<T>(key: string, fallback: T): T {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  if (isWorkspaceSettingsEnabled(resource)) {
    return config.get<T>(key, fallback);
  }
  const inspection = config.inspect<T>(key);
  if (!inspection) {
    return fallback;
  }
  if (inspection.globalValue !== undefined) {
    return inspection.globalValue as T;
  }
  if (inspection.defaultValue !== undefined) {
    return inspection.defaultValue as T;
  }
  return fallback;
}
