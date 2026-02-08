import * as vscode from 'vscode';
import { REFERENCES_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import {
  extractLocations,
  locationToSummaryPath,
  parseLimit,
  readLineTextFromFile,
  renderReferenceSummary,
  toStructuredLocation,
  toTextDocumentPositionParams,
} from './aiCommon';
import { errorResult, successTextResult } from './shared';

function parseIncludeDeclaration(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  return Boolean(value);
}

export async function runSymbolReferencesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const { uri, position } = toTextDocumentPositionParams(input);
    const includeDeclaration = parseIncludeDeclaration(input.includeDeclaration);
    const limit = parseLimit(input, 'limit', 200, 500);

    const raw = await sendRequestWithAutoStart<unknown>(REFERENCES_METHOD, {
      textDocument: { uri },
      position,
      context: {
        includeDeclaration,
      },
    });

    const allLocations = extractLocations(raw);
    const shownLocations = allLocations.slice(0, limit);
    const cache = new Map<string, string[] | null>();
    const entries: SummaryEntry[] = [];
    const structuredEntries: Array<Record<string, unknown>> = [];
    for (const location of shownLocations) {
      const lineText = await readLineTextFromFile(location.filePath, location.startLine, cache);
      const summary = renderReferenceSummary(location, lineText);
      const path = locationToSummaryPath(location);
      entries.push({
        location: path,
        summary,
      });
      const preview = lineText.trim();
      structuredEntries.push({
        location: toStructuredLocation(location, preview),
        summary,
      });
    }

    const counts = {
      total: allLocations.length,
      shown: entries.length,
      truncated: allLocations.length > entries.length,
      kind: 'symbolReferences',
      extras: {
        includeDeclaration,
      },
    };
    const text = renderSummaryText(
      counts,
      entries,
    );
    return successTextResult(text, {
      kind: 'symbolReferences',
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
