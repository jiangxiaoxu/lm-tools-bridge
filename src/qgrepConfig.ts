import * as path from 'node:path';

function normalizeSlash(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

export function upsertWorkspaceConfigPathLine(textNormalized: string, workspaceRootPath: string): string {
  const hasFinalNewline = textNormalized.endsWith('\n');
  const body = hasFinalNewline ? textNormalized.slice(0, -1) : textNormalized;
  const lines = body.length > 0 ? body.split('\n') : [];
  const expectedPathLine = `path ${normalizeSlash(path.resolve(workspaceRootPath))}`;
  const filteredLines = lines.filter((line) => !/^path\s+/u.test(line.trimStart()));
  filteredLines.unshift(expectedPathLine);
  const nextBody = filteredLines.join('\n');
  return hasFinalNewline ? `${nextBody}\n` : nextBody;
}
