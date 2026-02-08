import * as vscode from 'vscode';
import { SWITCH_SOURCE_HEADER_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText } from '../format/aiSummary';
import { formatSummaryPath, resolveInputFilePath } from '../workspacePath';
import { errorResult, readString, successTextResult } from './shared';

export async function runSwitchSourceHeaderTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const filePath = readString(input, 'filePath');
    const resolved = resolveInputFilePath(filePath);
    const result = await sendRequestWithAutoStart<string | undefined>(
      SWITCH_SOURCE_HEADER_METHOD,
      { uri: resolved.uri },
    );
    const sourcePath = result ? vscode.Uri.parse(result).fsPath : undefined;
    const sourcePathSummary = formatSummaryPath(resolved.absoluteFilePath, 0);
    const pairedPathSummary = sourcePath ? formatSummaryPath(sourcePath, 0) : null;
    const text = renderSummaryText(
      {
        total: 1,
        shown: 1,
        truncated: false,
        kind: 'switchSourceHeader',
        extras: {
          found: Boolean(sourcePath),
        },
      },
      [
        {
          location: sourcePathSummary,
          summary: sourcePath ? `paired file: ${pairedPathSummary}` : 'paired file: (not found)',
        },
      ],
    );
    return successTextResult(text, {
      kind: 'switchSourceHeader',
      found: Boolean(sourcePath),
      sourceFilePath: resolved.absoluteFilePath,
      sourcePath: sourcePathSummary,
      pairedFilePath: sourcePath ?? null,
      pairedPath: pairedPathSummary,
    });
  } catch (error) {
    return errorResult(error);
  }
}
