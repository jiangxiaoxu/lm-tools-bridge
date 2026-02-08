import * as vscode from 'vscode';
import { INLAY_HINTS_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText } from '../format/aiSummary';
import { formatSummaryPath, resolveInputFilePath } from '../workspacePath';
import {
  errorResult,
  readRange,
  readString,
  successTextResult,
} from './shared';

export async function runInlayHintsTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const filePath = readString(input, 'filePath');
    const resolved = resolveInputFilePath(filePath);
    const range = readRange(input, 'range');
    const result = await sendRequestWithAutoStart<unknown>(INLAY_HINTS_METHOD, {
      textDocument: { uri: resolved.uri },
      range,
    });
    const hints = Array.isArray(result) ? result.length : 0;
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const text = renderSummaryText(
      {
        total: hints,
        shown: hints,
        truncated: false,
        kind: 'inlayHints',
      },
      [
        {
          location: formatSummaryPath(resolved.absoluteFilePath, startLine, endLine !== startLine ? endLine : undefined),
          summary: `hints=${hints}`,
        },
      ],
    );
    return successTextResult(text);
  } catch (error) {
    return errorResult(error);
  }
}
