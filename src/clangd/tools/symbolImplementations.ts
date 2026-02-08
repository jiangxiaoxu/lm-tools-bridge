import * as vscode from 'vscode';
import { IMPLEMENTATION_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import { extractLocations, locationToSummaryPath, parseLimit, readLineTextFromFile, toTextDocumentPositionParams } from './aiCommon';
import { errorResult, successTextResult } from './shared';

export async function runSymbolImplementationsTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const { uri, position } = toTextDocumentPositionParams(input);
    const limit = parseLimit(input, 'limit', 100, 300);

    const raw = await sendRequestWithAutoStart<unknown>(IMPLEMENTATION_METHOD, {
      textDocument: { uri },
      position,
    });

    const allLocations = extractLocations(raw);
    const shownLocations = allLocations.slice(0, limit);
    const cache = new Map<string, string[] | null>();
    const entries: SummaryEntry[] = [];
    const structuredEntries: Array<Record<string, unknown>> = [];
    for (const location of shownLocations) {
      const lineText = await readLineTextFromFile(location.filePath, location.startLine, cache);
      const summary = lineText.trim().length > 0 ? lineText.trim() : 'implementation';
      const path = locationToSummaryPath(location);
      entries.push({
        location: path,
        summary,
      });
      structuredEntries.push({
        location: {
          path,
          filePath: location.filePath,
          startLine: location.startLine,
          startCharacter: location.startCharacter,
          endLine: location.endLine,
          endCharacter: location.endCharacter,
        },
        summary,
      });
    }

    const counts = {
      total: allLocations.length,
      shown: entries.length,
      truncated: allLocations.length > entries.length,
      kind: 'symbolImplementations',
    };
    const text = renderSummaryText(
      counts,
      entries,
    );
    return successTextResult(text, {
      kind: 'symbolImplementations',
      counts: {
        total: counts.total,
        shown: counts.shown,
        truncated: counts.truncated,
      },
      entries: structuredEntries,
    });
  } catch (error) {
    return errorResult(error);
  }
}
