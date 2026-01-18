import http from 'node:http';
import process from 'node:process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';

const MANAGER_TIMEOUT_MS = 1500;
const RESOLVE_RETRIES = 10;
const RESOLVE_RETRY_DELAY_MS = 500;
const STARTUP_GRACE_MS = 5000;
const LOG_ENV = 'LM_TOOLS_BRIDGE_PROXY_LOG';
const ERROR_MANAGER_UNREACHABLE = -32003;
const ERROR_NO_MATCH = -32004;
const STARTUP_TIME = Date.now();

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

function isSameTarget(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.host === right.host && left.port === right.port;
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
                process.stdout.write(`${text}\n`);
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
  const cwd = process.cwd();
  let currentTargetResult = await resolveTarget(cwd);
  let currentTarget = currentTargetResult.target;
  if (!currentTarget) {
    appendLog(`No VS Code instance registered for cwd: ${cwd}`);
  }

  let resolveInFlight;
  const refreshTarget = async (deadlineMs) => {
    if (resolveInFlight) {
      return resolveInFlight;
    }
    const resolver = deadlineMs ? resolveTargetWithDeadline(cwd, deadlineMs) : resolveTarget(cwd);
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
