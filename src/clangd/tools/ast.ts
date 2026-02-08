import * as vscode from 'vscode';
import { AST_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText } from '../format/aiSummary';
import { formatSummaryPath, resolveInputFilePath } from '../workspacePath';
import {
  errorResult,
  readRange,
  readString,
  successTextResult,
} from './shared';

export async function runAstTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const filePath = readString(input, 'filePath');
    const resolved = resolveInputFilePath(filePath);
    const range = readRange(input, 'range');
    const result = await sendRequestWithAutoStart<unknown>(AST_METHOD, {
      textDocument: { uri: resolved.uri },
      range,
    });
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const astText = JSON.stringify(result ?? null, null, 2);
    const summaryPath = formatSummaryPath(resolved.absoluteFilePath, startLine, endLine !== startLine ? endLine : undefined);
    const text = renderSummaryText(
      {
        total: 1,
        shown: 1,
        truncated: false,
        kind: 'ast',
      },
      [
        {
          location: summaryPath,
          summary: 'AST payload is included below as JSON.',
        },
      ],
      [astText],
    );
    return successTextResult(text, {
      kind: 'ast',
      location: {
        path: summaryPath,
        filePath: resolved.absoluteFilePath,
        startLine,
        endLine,
      },
      ast: result ?? null,
    });
  } catch (error) {
    return errorResult(error);
  }
}
