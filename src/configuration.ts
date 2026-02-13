import * as vscode from 'vscode';
import * as path from 'node:path';

export const CONFIG_SECTION = 'lmToolsBridge';
export const CONFIG_USE_WORKSPACE_SETTINGS = 'useWorkspaceSettings';
export const USE_WORKSPACE_SETTINGS_USER_SCOPE_WARNING = 'lmToolsBridge.useWorkspaceSettings is set in User settings but is only honored in Workspace settings.';

let workspaceSettingWarningEmitted = false;
let warnLogger: ((message: string) => void) | undefined;

type WorkspaceScopedInspection<T> = {
  workspaceValue?: T;
  workspaceFolderValue?: T;
};

export function setConfigurationWarningLogger(logger: (message: string) => void): void {
  warnLogger = logger;
}

export function getConfigurationResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function isWorkspaceFileContext(): boolean {
  return Boolean(vscode.workspace.workspaceFile);
}

function getWorkspaceScopedInspectionValue<T>(inspection: WorkspaceScopedInspection<T>): T | undefined {
  if (isWorkspaceFileContext()) {
    return inspection.workspaceValue;
  }
  return inspection.workspaceFolderValue ?? inspection.workspaceValue;
}

export function isWorkspaceSettingsEnabled(resource?: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const inspection = config.inspect<boolean>(CONFIG_USE_WORKSPACE_SETTINGS);
  const workspaceValue = inspection ? getWorkspaceScopedInspectionValue(inspection) : undefined;
  if (workspaceValue === true) {
    return true;
  }
  if (!workspaceSettingWarningEmitted && inspection?.globalValue === true) {
    workspaceSettingWarningEmitted = true;
    const logger = warnLogger ?? console.warn;
    logger(USE_WORKSPACE_SETTINGS_USER_SCOPE_WARNING);
  }
  return false;
}

export async function clearUseWorkspaceSettingsFromUserSettings(resource?: vscode.Uri): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const inspection = config.inspect<boolean>(CONFIG_USE_WORKSPACE_SETTINGS);
  if (!inspection || inspection.globalValue === undefined) {
    return false;
  }
  await config.update(CONFIG_USE_WORKSPACE_SETTINGS, undefined, vscode.ConfigurationTarget.Global);
  return true;
}

export async function resolveToolsConfigTarget(resource?: vscode.Uri): Promise<vscode.ConfigurationTarget> {
  return resolveActiveConfigTarget(resource);
}

export function resolveActiveConfigTarget(resource?: vscode.Uri): vscode.ConfigurationTarget {
  if (!isWorkspaceSettingsEnabled(resource)) {
    return vscode.ConfigurationTarget.Global;
  }
  if (isWorkspaceFileContext()) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.WorkspaceFolder;
}

function resolveWorkspaceFolderForResource(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (resource) {
    const matched = vscode.workspace.getWorkspaceFolder(resource);
    if (matched) {
      return matched;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function getConfigScopeDescription(
  resource?: vscode.Uri,
  targetOverride?: vscode.ConfigurationTarget,
): string {
  const target = targetOverride ?? resolveActiveConfigTarget(resource);
  if (target === vscode.ConfigurationTarget.Global) {
    return 'User settings';
  }
  if (target === vscode.ConfigurationTarget.Workspace) {
    const workspaceFilePath = vscode.workspace.workspaceFile?.fsPath;
    if (workspaceFilePath) {
      return `Workspace settings (${workspaceFilePath})`;
    }
    return 'Workspace settings (.code-workspace)';
  }

  const workspaceFolder = resolveWorkspaceFolderForResource(resource);
  if (workspaceFolder) {
    const settingsFilePath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'settings.json');
    return `Workspace folder settings (${settingsFilePath})`;
  }
  return 'Workspace folder settings (.vscode/settings.json)';
}

export function getConfigValue<T>(key: string, fallback: T): T {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const inspection = config.inspect<T>(key);
  if (!inspection) {
    return fallback;
  }
  if (isWorkspaceSettingsEnabled(resource)) {
    const workspaceValue = getWorkspaceScopedInspectionValue(inspection);
    if (workspaceValue !== undefined) {
      return workspaceValue as T;
    }
    if (inspection.defaultValue !== undefined) {
      return inspection.defaultValue as T;
    }
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
