import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const MANAGER_TIMEOUT_MS = 1500;

function getUserSeed() {
  return process.env.USERNAME ?? process.env.USERPROFILE ?? os.userInfo().username ?? 'default-user';
}

function getManagerPipeName() {
  const hash = crypto.createHash('sha1').update(getUserSeed()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\lm-tools-bridge-manager-${hash}`;
}

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

async function managerRequest(cwdValue, pipeName) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ cwd: cwdValue });
    const request = http.request(
      {
        socketPath: pipeName,
        path: '/resolve',
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
          const status = response.statusCode ?? 500;
          const text = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
          resolve({ status, text });
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, MANAGER_TIMEOUT_MS);

    request.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: 0, text: String(error) });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.write(payload);
    request.end();
  });
}

async function main() {
  const cwdArg = readArg('--cwd');
  const pipeArg = readArg('--pipe');
  const cwdValue = cwdArg ? path.resolve(cwdArg) : process.cwd();
  const pipeName = pipeArg ?? getManagerPipeName();

  const result = await managerRequest(cwdValue, pipeName);
  if (result.status === 0) {
    console.error(`Manager request failed: ${result.text}`);
    process.exit(1);
    return;
  }

  if (result.status === 404) {
    console.error('No matching VS Code instance found.');
    process.exit(2);
    return;
  }

  console.log(result.text);
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}

main().catch((error) => {
  console.error(`Resolve test failed: ${String(error)}`);
  process.exit(1);
});
