import * as crypto from 'node:crypto';
import * as os from 'node:os';

const PIPE_PREFIX = 'lm-tools-bridge-manager';

function getUserSeed(): string {
  return process.env.USERNAME ?? process.env.USERPROFILE ?? os.userInfo().username ?? 'default-user';
}

function hashUserSeed(seed: string): string {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

export function getManagerPipeName(): string {
  const hash = hashUserSeed(getUserSeed());
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${hash}`;
}
