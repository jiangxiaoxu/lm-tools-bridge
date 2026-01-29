#!/usr/bin/env node
import http from 'node:http';
import process from 'node:process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANAGER_TIMEOUT_MS = 1500;
const RESOLVE_RETRIES = 10;
const RESOLVE_RETRY_DELAY_MS = 500;
const STARTUP_GRACE_MS = 5000;
const LOG_ENV = 'LM_TOOLS_BRIDGE_PROXY_LOG';
const ERROR_MANAGER_UNREACHABLE = -32003;
const ERROR_NO_MATCH = -32004;
const ERROR_WORKSPACE_NOT_SET = -32005;
const ERROR_MCP_OFFLINE = -32006;
const STARTUP_TIME = Date.now();
const REQUEST_WORKSPACE_METHOD = 'lmTools/requestWorkspaceMCPServer';
const STATUS_METHOD = 'lmTools/status';
const TOOLS_LIST_METHOD = 'tools/list';
const TOOLS_CALL_METHOD = 'tools/call';
const HEALTH_PATH = '/mcp/health';
const HEALTH_TIMEOUT_MS = 1200;
const HANDSHAKE_RESOURCE_URI = 'lm-tools-bridge-proxy://handshake';

type ManagerMatch = {
  sessionId: string;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFile?: string | null;
};

function getUserSeed() {
  return process.env.USERNAME ?? process.env.USERPROFILE ?? os.userInfo().username ?? 'default-user';
}

function getManagerPipeName() {
  const hash = crypto.createHash('sha1').update(getUserSeed()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\lm-tools-bridge-manager-${hash}`;
}

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveTargetWithDeadline(cwd, deadlineMs) {
  let sawNoMatch = false;
  let sawUnreachable = false;
  while (Date.now() < deadlineMs) {
    const result = await managerRequest('POST', '/resolve', { cwd });
    if (result.ok && result.data && result.data.match) {
      return { target: result.data.match, errorKind: undefined };
    }
    if (result.errorKind === 'no_match') {
      sawNoMatch = true;
    } else if (result.errorKind === 'unreachable') {
      sawUnreachable = true;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(RESOLVE_RETRY_DELAY_MS, remaining));
  }
  if (sawNoMatch) {
    return { target: undefined, errorKind: 'no_match' };
  }
  if (sawUnreachable) {
    return { target: undefined, errorKind: 'unreachable' };
  }
  return { target: undefined, errorKind: 'unreachable' };
}

async function resolveTarget(cwd) {
  const deadline = Date.now() + (RESOLVE_RETRIES * RESOLVE_RETRY_DELAY_MS);
  return resolveTargetWithDeadline(cwd, deadline);
}

function isSameTarget(left: ManagerMatch | undefined, right: ManagerMatch | undefined) {
  if (!left || !right) {
    return false;
  }
  return left.host === right.host && left.port === right.port;
}

function buildRoots(match: ManagerMatch) {
  const folders = Array.isArray(match.workspaceFolders) ? match.workspaceFolders : [];
  return folders.map((folder) => {
    const resolved = path.resolve(folder);
    return {
      uri: pathToFileURL(resolved).toString(),
      name: path.basename(resolved),
    };
  });
}

function normalizeFsPath(value: string) {
  return path.resolve(value).toLowerCase();
}

function isCwdWithinWorkspaceFolders(cwd: string, workspaceFolders: string[]) {
  const normalizedCwd = normalizeFsPath(cwd);
  return workspaceFolders.some((folder) => {
    const normalizedFolder = normalizeFsPath(folder);
    const relative = path.relative(normalizedFolder, normalizedCwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

async function checkTargetHealth(target: ManagerMatch) {
  return new Promise<{ ok: boolean; status?: number; data?: unknown }>((resolve) => {
    const request = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path: HEALTH_PATH,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (chunks.length === 0) {
            resolve({ ok: status >= 200 && status < 300, status });
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text) as unknown;
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status });
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, HEALTH_TIMEOUT_MS);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

function isHealthOk(health?: { ok?: boolean } | null) {
  return health?.ok === true;
}

function toOfflineDurationSec(startedAt?: number) {
  if (!startedAt) {
    return null;
  }
  return Math.floor((Date.now() - startedAt) / 1000);
}

async function managerRequest(method, requestPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        socketPath: getManagerPipeName(),
        path: requestPath,
        method,
        headers: payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (status === 404) {
            resolve({ ok: false, status, errorKind: 'no_match' });
            return;
          }
          if (chunks.length === 0) {
            resolve({ ok: status >= 200 && status < 300, status });
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text);
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status });
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, MANAGER_TIMEOUT_MS);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false, errorKind: 'unreachable' });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function getLogPath() {
  return process.env[LOG_ENV];
}

function appendLog(message) {
  const logPath = getLogPath();
  if (!logPath) {
    return;
  }
  try {
    fs.appendFileSync(logPath, `${message}\n`, { encoding: 'utf8' });
  } catch {
    // Ignore log failures.
  }
}

function logDebug(tag: string, payload?: Record<string, unknown>) {
  if (!payload) {
    appendLog(`[${tag}]`);
    return;
  }
  appendLog(`[${tag}] ${JSON.stringify(payload)}`);
}

function createStdioMessageHandler(targetGetter, targetRefresher, stateGetter) {
  return async (message) => {
    const state = stateGetter();
    if (!state.workspaceMatched) {
      if (message?.method === 'resources/list') {
        logDebug('resources.list.handshake', { id: message.id ?? null });
        if (message.id === undefined || message.id === null) {
          return;
        }
        const resultPayload = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            resources: [
              {
                uri: HANDSHAKE_RESOURCE_URI,
                name: 'MCP proxy handshake',
                description: 'Call lmTools/requestWorkspaceMCPServer with params.cwd before using MCP.',
                mimeType: 'text/plain',
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
        return;
      }
      if (message?.method === 'resources/read' && message?.params?.uri === HANDSHAKE_RESOURCE_URI) {
        logDebug('resources.read.handshake', { id: message.id ?? null });
        if (message.id === undefined || message.id === null) {
          return;
        }
        const content = [
          'This MCP proxy requires an explicit workspace handshake.',
          'Call lmTools/requestWorkspaceMCPServer with params.cwd, wait for ok:true.',
          'Then call lmTools/status to confirm online status.',
        ].join('\n');
        const resultPayload = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            contents: [
              {
                uri: HANDSHAKE_RESOURCE_URI,
                mimeType: 'text/plain',
                text: content,
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
        return;
      }
      if (message.id === undefined || message.id === null) {
        return;
      }
      const errorPayload = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: state.workspaceSetExplicitly ? ERROR_NO_MATCH : ERROR_WORKSPACE_NOT_SET,
          message: state.workspaceSetExplicitly
            ? 'Workspace not matched. Call lmTools/requestWorkspaceMCPServer with params.cwd and wait for success.'
            : 'Workspace not set. Call lmTools/requestWorkspaceMCPServer with params.cwd before using MCP.',
        },
      };
      if (message?.method === 'roots/list') {
        appendLog(`roots/list => ${JSON.stringify({ error: errorPayload.error })}`);
      }
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
      return;
    }

    if (message?.method === 'roots/list') {
      logDebug('roots.list.request', { id: message.id ?? null });
      let target = targetGetter();
      if (!target) {
        const now = Date.now();
        const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
        const refreshResult = await targetRefresher(now < graceDeadline ? graceDeadline : undefined);
        target = refreshResult?.target;
        if (!target) {
          const errorKind = refreshResult?.errorKind ?? 'unreachable';
          if (message.id === undefined || message.id === null) {
            return;
          }
          const errorPayload = {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
              message: errorKind === 'no_match'
                ? 'No matching VS Code instance for current workspace.'
                : 'Manager unreachable.',
            },
          };
          appendLog(`roots/list => ${JSON.stringify({ error: errorPayload.error })}`);
          process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
          return;
        }
      }
      const health = await checkTargetHealth(target);
      if (!isHealthOk(health)) {
        workspaceMatched = false;
        currentTarget = undefined;
        if (!offlineSince) {
          offlineSince = Date.now();
        }
        const errorPayload = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: ERROR_MCP_OFFLINE,
            message: 'Resolved MCP server is offline.',
          },
        };
        logDebug('roots.list.offline', { target: `${target.host}:${target.port}`, health });
        appendLog(`roots/list => ${JSON.stringify({ error: errorPayload.error })}`);
        process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
        return;
      }
      const rootsResult = {
        roots: buildRoots(target),
      };
      logDebug('roots.list.ok', { target: `${target.host}:${target.port}`, roots: rootsResult.roots.length });
      appendLog(`roots/list => ${JSON.stringify(rootsResult)}`);
      if (message.id === undefined || message.id === null) {
        return;
      }
      const resultPayload = {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          roots: rootsResult.roots,
        },
      };
      process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
      return;
    }
    const payload = JSON.stringify(message);
    let target = targetGetter();
    if (!target) {
      const now = Date.now();
      const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
      const refreshResult = await targetRefresher(now < graceDeadline ? graceDeadline : undefined);
      target = refreshResult?.target;
      if (!target) {
        appendLog('No target resolved for MCP proxy.');
        if (message.id === undefined || message.id === null) {
          return;
        }
        const errorKind = refreshResult?.errorKind ?? 'unreachable';
        const errorPayload = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
            message: errorKind === 'no_match'
              ? 'No matching VS Code instance for current workspace.'
              : 'Manager unreachable.',
          },
        };
        process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
        return;
      }
    }

    const attemptSend = async (sendTarget) => {
      return new Promise((resolve) => {
        const targetUrl = new URL(`http://${sendTarget.host}:${sendTarget.port}/mcp`);
        const request = http.request(
          {
            hostname: targetUrl.hostname,
            port: Number(targetUrl.port),
            path: targetUrl.pathname,
            method: 'POST',
            headers: {
              Accept: 'application/json, text/event-stream',
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              if (text.length > 0) {
                const contentType = Array.isArray(response.headers['content-type'])
                  ? response.headers['content-type'].join(';')
                  : response.headers['content-type'] ?? '';
                if (contentType.includes('text/event-stream')) {
                  const events = text.split(/\r?\n\r?\n/);
                  for (const eventBlock of events) {
                    const lines = eventBlock.split(/\r?\n/);
                    const dataLines = lines
                      .filter((line) => line.startsWith('data:'))
                      .map((line) => line.slice(5).trimStart());
                    if (dataLines.length === 0) {
                      continue;
                    }
                    const dataText = dataLines.join('\n').trim();
                    if (dataText.length === 0 || dataText === '[DONE]') {
                      continue;
                    }
                    process.stdout.write(`${dataText}\n`);
                  }
                } else {
                  process.stdout.write(`${text}\n`);
                }
              }
              resolve({ ok: true });
            });
          },
        );

        request.on('error', (error) => {
          resolve({ ok: false, error });
        });

        request.write(payload);
        request.end();
      });
    };

    logDebug('mcp.forward.start', {
      id: message.id ?? null,
      method: message?.method ?? null,
      target: `${target.host}:${target.port}`,
    });
    const firstAttempt = await attemptSend(target);
    if (firstAttempt.ok) {
      logDebug('mcp.forward.ok', { id: message.id ?? null, target: `${target.host}:${target.port}` });
      return;
    }

    appendLog(`MCP proxy request failed: ${String(firstAttempt.error)}`);
    logDebug('mcp.forward.error', {
      id: message.id ?? null,
      target: `${target.host}:${target.port}`,
      error: String(firstAttempt.error),
    });
    const firstHealth = await checkTargetHealth(target);
    if (!isHealthOk(firstHealth)) {
      workspaceMatched = false;
      currentTarget = undefined;
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      logDebug('mcp.forward.offline', { id: message.id ?? null, target: `${target.host}:${target.port}` });
      if (message.id === undefined || message.id === null) {
        return;
      }
      const errorPayload = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: ERROR_MCP_OFFLINE,
          message: 'Resolved MCP server is offline.',
        },
      };
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
      return;
    }
    const now = Date.now();
    const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
    const refreshResult = await targetRefresher(now < graceDeadline ? graceDeadline : undefined);
    const refreshed = refreshResult?.target;
    if (!refreshed || isSameTarget(target, refreshed)) {
      const errorKind = refreshResult?.errorKind ?? 'unreachable';
      logDebug('mcp.forward.noRefresh', {
        id: message.id ?? null,
        errorKind,
      });
      if (message.id === undefined || message.id === null) {
        return;
      }
      const errorPayload = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
          message: errorKind === 'no_match'
            ? 'No matching VS Code instance for current workspace.'
            : 'Manager unreachable.',
        },
      };
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
      return;
    }

    const refreshedHealth = await checkTargetHealth(refreshed);
    if (!isHealthOk(refreshedHealth)) {
      workspaceMatched = false;
      currentTarget = undefined;
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      logDebug('mcp.forward.refreshedOffline', {
        id: message.id ?? null,
        target: `${refreshed.host}:${refreshed.port}`,
        health: refreshedHealth,
      });
      if (message.id === undefined || message.id === null) {
        return;
      }
      const errorPayload = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: ERROR_MCP_OFFLINE,
          message: 'Resolved MCP server is offline.',
        },
      };
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
      return;
    }
    const retryAttempt = await attemptSend(refreshed);
    if (retryAttempt.ok) {
      logDebug('mcp.forward.retryOk', { id: message.id ?? null, target: `${refreshed.host}:${refreshed.port}` });
      return;
    }

    appendLog(`MCP proxy retry failed: ${String(retryAttempt.error)}`);
    logDebug('mcp.forward.retryError', {
      id: message.id ?? null,
      target: `${refreshed.host}:${refreshed.port}`,
      error: String(retryAttempt.error),
    });
    if (message.id === undefined || message.id === null) {
      return;
    }
    const errorPayload = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: ERROR_MANAGER_UNREACHABLE,
        message: 'Manager unreachable.',
      },
    };
    process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
  };
}

async function main() {
  let resolveCwd = process.cwd();
  let workspaceSetExplicitly = false;
  let workspaceMatched = false;
  let offlineSince: number | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  // Env snapshot logging removed to avoid noisy logs.
  let currentTarget;

  let resolveInFlight;
  const refreshTarget = async (deadlineMs) => {
    if (resolveInFlight) {
      return resolveInFlight;
    }
    const resolver = deadlineMs ? resolveTargetWithDeadline(resolveCwd, deadlineMs) : resolveTarget(resolveCwd);
    resolveInFlight = resolver.finally(() => {
      resolveInFlight = undefined;
    });
    const resolved = await resolveInFlight;
    if (resolved?.target) {
      currentTarget = resolved.target;
    }
    return resolved;
  };

  const getState = () => ({
    workspaceSetExplicitly,
    workspaceMatched,
  });

  const handler = createStdioMessageHandler(() => currentTarget, refreshTarget, getState);
  let buffer = '';
  const reconnectLoop = async () => {
    if (!workspaceSetExplicitly || workspaceMatched || resolveInFlight) {
      return;
    }
    logDebug('reconnect.attempt', { cwd: resolveCwd });
    const resolveResult = await refreshTarget();
    const resolvedTarget = resolveResult?.target;
    if (!resolvedTarget) {
      logDebug('reconnect.noMatch', { errorKind: resolveResult?.errorKind ?? 'unreachable' });
      return;
    }
    if (!isCwdWithinWorkspaceFolders(resolveCwd, resolvedTarget.workspaceFolders)) {
      logDebug('reconnect.cwdMismatch', { cwd: resolveCwd, workspaceFolders: resolvedTarget.workspaceFolders });
      return;
    }
    const resolvedHealth = await checkTargetHealth(resolvedTarget);
    if (!isHealthOk(resolvedHealth)) {
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      logDebug('reconnect.offline', {
        target: `${resolvedTarget.host}:${resolvedTarget.port}`,
        health: resolvedHealth,
      });
      return;
    }
    currentTarget = resolvedTarget;
    workspaceMatched = true;
    offlineSince = undefined;
    logDebug('reconnect.ok', { target: `${resolvedTarget.host}:${resolvedTarget.port}` });
  };
  reconnectTimer = setInterval(() => {
    void reconnectLoop();
  }, 1000);
  const proxyToolsList = [
    {
      name: REQUEST_WORKSPACE_METHOD,
      description: 'Resolve and bind a workspace MCP server. Input: { cwd: string }.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Workspace path to resolve.' },
        },
        required: ['cwd'],
      },
    },
    {
      name: STATUS_METHOD,
      description: 'Get proxy status and online state for the current target.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
  const respondToolCall = (id, payload) => {
    const resultPayload = {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: payload,
      },
    };
    process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
  };
  const respondToolError = (id, code, message) => {
    const errorPayload = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
  };
  const buildStatusPayload = async () => {
    let resolveResult;
    if (workspaceSetExplicitly && !workspaceMatched) {
      const deadline = Date.now() + RESOLVE_RETRY_DELAY_MS;
      resolveResult = await refreshTarget(deadline);
    }
    const target = workspaceSetExplicitly ? currentTarget : undefined;
    const health = target ? await checkTargetHealth(target) : undefined;
    const online = isHealthOk(health);
    if (!online && target) {
      workspaceMatched = false;
      currentTarget = undefined;
      if (!offlineSince) {
        offlineSince = Date.now();
      }
    } else if (online) {
      offlineSince = undefined;
    }
    const ready = workspaceMatched && Boolean(target) && online;
    return {
      payload: {
        ready,
        online,
        workspaceSetExplicitly,
        cwd: resolveCwd,
        offlineDurationSec: toOfflineDurationSec(offlineSince),
        target: target
          ? {
            sessionId: target.sessionId,
            host: target.host,
            port: target.port,
            workspaceFolders: target.workspaceFolders,
            workspaceFile: target.workspaceFile ?? null,
          }
          : null,
        resolveErrorKind: resolveResult?.errorKind,
        health,
      },
      debug: {
        ready,
        online,
        workspaceSetExplicitly,
        workspaceMatched,
        offlineDurationSec: toOfflineDurationSec(offlineSince),
        target: target ? `${target.host}:${target.port}` : null,
        resolveErrorKind: resolveResult?.errorKind ?? null,
      },
    };
  };
  const handleRequestWorkspace = async (cwdValue) => {
    if (typeof cwdValue !== 'string' || cwdValue.trim().length === 0) {
      return { error: { code: -32602, message: 'Invalid params: expected params.cwd (string).' } };
    }
    resolveCwd = path.resolve(cwdValue);
    workspaceSetExplicitly = true;
    workspaceMatched = false;
    currentTarget = undefined;
    resolveInFlight = undefined;
    const resolveResult = await refreshTarget();
    const matchedTarget = resolveResult?.target;
    if (!matchedTarget) {
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      return {
        error: {
          code: resolveResult?.errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
          message: resolveResult?.errorKind === 'no_match'
            ? 'No matching VS Code instance for provided workspace.'
            : 'Manager unreachable.',
        },
        debug: {
          errorKind: resolveResult?.errorKind ?? 'unreachable',
          cwd: resolveCwd,
        },
      };
    }
    if (!isCwdWithinWorkspaceFolders(resolveCwd, matchedTarget.workspaceFolders)) {
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      return {
        error: {
          code: ERROR_NO_MATCH,
          message: 'Provided cwd is not within resolved workspace folders.',
        },
        debug: {
          cwd: resolveCwd,
          workspaceFolders: matchedTarget.workspaceFolders,
        },
      };
    }
    const health = await checkTargetHealth(matchedTarget);
    if (!isHealthOk(health)) {
      workspaceMatched = false;
      currentTarget = undefined;
      if (!offlineSince) {
        offlineSince = Date.now();
      }
      return {
        error: {
          code: ERROR_MCP_OFFLINE,
          message: 'Resolved MCP server is offline.',
        },
        debug: {
          target: `${matchedTarget.host}:${matchedTarget.port}`,
          health,
        },
      };
    }
    workspaceMatched = true;
    currentTarget = matchedTarget;
    offlineSince = undefined;
    return {
      payload: {
        ok: true,
        cwd: resolveCwd,
        target: {
          sessionId: matchedTarget.sessionId,
          host: matchedTarget.host,
          port: matchedTarget.port,
          workspaceFolders: matchedTarget.workspaceFolders,
          workspaceFile: matchedTarget.workspaceFile ?? null,
        },
        online: true,
        health,
      },
      debug: {
        cwd: resolveCwd,
        target: `${matchedTarget.host}:${matchedTarget.port}`,
      },
    };
  };
  const handleMessage = async (message) => {
    if (message?.method === TOOLS_LIST_METHOD) {
      if (!workspaceMatched) {
        logDebug('tools.list.proxy', { id: message.id ?? null });
        if (message.id !== undefined && message.id !== null) {
          const resultPayload = {
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: proxyToolsList },
          };
          process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
        }
        return;
      }
    }
    if (message?.method === TOOLS_CALL_METHOD) {
      const name = message?.params?.name;
      const args = message?.params?.arguments ?? {};
      if (message.id === undefined || message.id === null) {
        return;
      }
      if (name === REQUEST_WORKSPACE_METHOD) {
        const result = await handleRequestWorkspace(args?.cwd);
        if (result.error) {
          respondToolError(message.id, result.error.code, result.error.message);
          return;
        }
        respondToolCall(message.id, result.payload);
        return;
      }
      if (name === STATUS_METHOD) {
        const statusResult = await buildStatusPayload();
        respondToolCall(message.id, statusResult.payload);
        return;
      }
      if (!workspaceMatched) {
        respondToolError(message.id, -32602, `Unknown tool: ${String(name)}`);
        return;
      }
    }
    if (message?.method === STATUS_METHOD) {
      logDebug('status.request', { id: message.id ?? null });
      const statusResult = await buildStatusPayload();
      logDebug('status.state', statusResult.debug);
      if (message.id !== undefined && message.id !== null) {
        const resultPayload = {
          jsonrpc: '2.0',
          id: message.id,
          result: statusResult.payload,
        };
        process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
      }
      return;
    }
    if (message?.method === REQUEST_WORKSPACE_METHOD) {
      logDebug('requestWorkspaceMCPServer.request', { id: message.id ?? null, cwd: message?.params?.cwd ?? null });
      const result = await handleRequestWorkspace(message?.params?.cwd);
      if (result.error) {
        logDebug('requestWorkspaceMCPServer.error', {
          code: result.error.code,
          message: result.error.message,
          ...(result.debug ?? {}),
        });
        if (message.id !== undefined && message.id !== null) {
          const errorPayload = {
            jsonrpc: '2.0',
            id: message.id,
            error: result.error,
          };
          process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
        }
        return;
      }
      if (result.debug) {
        logDebug('requestWorkspaceMCPServer.ok', result.debug);
      }
      if (message.id !== undefined && message.id !== null) {
        const resultPayload = {
          jsonrpc: '2.0',
          id: message.id,
          result: result.payload,
        };
        process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
      }
      return;
    }
    void handler(message);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line);
          void handleMessage(message);
        } catch {
          appendLog('Invalid JSON received by MCP proxy.');
          const errorPayload = {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Invalid JSON received by MCP proxy.',
            },
          };
          process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  process.stdin.on('end', () => {
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = undefined;
    }
    process.exit(0);
  });
}

main().catch((error) => {
  appendLog(`MCP proxy startup failed: ${String(error)}`);
  const errorPayload = {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32002,
      message: `MCP proxy startup failed: ${String(error)}`,
    },
  };
  process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
  process.exit(1);
});
