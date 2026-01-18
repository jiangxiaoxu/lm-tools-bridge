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
const STARTUP_TIME = Date.now();
const SET_WORKSPACE_METHOD = 'lmTools/setWorkspace';

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

function createStdioMessageHandler(targetGetter, targetRefresher) {
  return async (message) => {
    if (message?.method === 'roots/list') {
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
      const rootsResult = {
        roots: buildRoots(target),
      };
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

    const firstAttempt = await attemptSend(target);
    if (firstAttempt.ok) {
      return;
    }

    appendLog(`MCP proxy request failed: ${String(firstAttempt.error)}`);
    const now = Date.now();
    const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
    const refreshResult = await targetRefresher(now < graceDeadline ? graceDeadline : undefined);
    const refreshed = refreshResult?.target;
    if (!refreshed || isSameTarget(target, refreshed)) {
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
      process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
      return;
    }

    const retryAttempt = await attemptSend(refreshed);
    if (retryAttempt.ok) {
      return;
    }

    appendLog(`MCP proxy retry failed: ${String(retryAttempt.error)}`);
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
  const envSnapshot = Object.entries(process.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('\n');
  appendLog(`ENV_VARS_BEGIN\n${envSnapshot}\nENV_VARS_END`);
  const vscodeCwd = process.env.VSCODE_CWD;
  if (vscodeCwd) {
    resolveCwd = path.resolve(vscodeCwd);
    workspaceSetExplicitly = true;
    appendLog(`VSCODE_CWD=${vscodeCwd}`);
  } else {
    appendLog('VSCODE_CWD not found');
  }
  let currentTargetResult = await resolveTarget(resolveCwd);
  let currentTarget = currentTargetResult.target;
  if (!currentTarget) {
    appendLog(`No VS Code instance registered for cwd: ${resolveCwd}`);
  }

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

  const handler = createStdioMessageHandler(() => currentTarget, refreshTarget);
  let buffer = '';

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
          if (message?.method === SET_WORKSPACE_METHOD) {
            const nextCwd = message?.params?.cwd;
            if (typeof nextCwd !== 'string' || nextCwd.trim().length === 0) {
              if (message.id !== undefined && message.id !== null) {
                const errorPayload = {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: {
                    code: -32602,
                    message: 'Invalid params: expected params.cwd (string).',
                  },
                };
                process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
              }
              return;
            }
            resolveCwd = path.resolve(nextCwd);
            workspaceSetExplicitly = true;
            currentTarget = undefined;
            void refreshTarget();
            if (message.id !== undefined && message.id !== null) {
              const resultPayload = {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  ok: true,
                  cwd: resolveCwd,
                },
              };
              process.stdout.write(`${JSON.stringify(resultPayload)}\n`);
            }
            return;
          }
          if (!workspaceSetExplicitly) {
            if (message?.method === 'roots/list' || message?.method === undefined) {
              const errorPayload = {
                jsonrpc: '2.0',
                id: message?.id ?? null,
                error: {
                  code: ERROR_WORKSPACE_NOT_SET,
                  message: 'Workspace not set. Call lmTools/setWorkspace with params.cwd before using MCP.',
                },
              };
              if (message?.id !== undefined && message?.id !== null) {
                process.stdout.write(`${JSON.stringify(errorPayload)}\n`);
              }
              return;
            }
          }
          void handler(message);
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
    process.exit(0);
  });

  void handler({ jsonrpc: '2.0', id: null, method: 'roots/list' });
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
