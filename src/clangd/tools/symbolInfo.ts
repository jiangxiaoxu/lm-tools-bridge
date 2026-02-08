import * as vscode from 'vscode';
import { DECLARATION_METHOD, DEFINITION_METHOD, HOVER_METHOD, SIGNATURE_HELP_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSection, renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import { locationToSummaryPath, readLineTextFromFile, readSnippetFromFile, toTextDocumentPositionParams, extractLocations, type FlatLocation } from './aiCommon';
import { errorResult, successTextResult } from './shared';

function parseIncludeSnippet(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return Boolean(value);
}

function parseSnippetMaxLines(value: unknown): number {
  if (value === undefined) {
    return 20;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return 20;
  }
  return Math.min(value, 120);
}

function isGeneratedSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.generated.h') || normalized.endsWith('.gen.cpp');
}

function locationKey(location: FlatLocation): string {
  return `${location.filePath}:${location.startLine}:${location.startCharacter}:${location.endLine}:${location.endCharacter}`;
}

function flattenHoverText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenHoverText(item)).filter((item) => item.length > 0).join('\n');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  if (typeof record.value === 'string') {
    return record.value;
  }
  if (record.contents !== undefined) {
    return flattenHoverText(record.contents);
  }
  return '';
}

function extractActiveSignatureLabel(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const record = value as Record<string, unknown>;
  const signatures = Array.isArray(record.signatures) ? record.signatures : [];
  if (signatures.length === 0) {
    return '';
  }
  const activeSignature = typeof record.activeSignature === 'number' && Number.isInteger(record.activeSignature)
    ? record.activeSignature
    : 0;
  const index = Math.min(Math.max(activeSignature, 0), signatures.length - 1);
  const selected = signatures[index];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return '';
  }
  const label = (selected as Record<string, unknown>).label;
  return typeof label === 'string' ? label : '';
}

export async function runSymbolInfoTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const { absoluteFilePath, uri, position } = toTextDocumentPositionParams(input);
    const includeSnippet = parseIncludeSnippet(input.includeSnippet);
    const snippetMaxLines = parseSnippetMaxLines(input.snippetMaxLines);

    const baseParams = {
      textDocument: { uri },
      position,
    };

    const [definitionRaw, declarationRaw, hoverRaw, signatureRaw] = await Promise.all([
      sendRequestWithAutoStart<unknown>(DEFINITION_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(DECLARATION_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(HOVER_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(SIGNATURE_HELP_METHOD, baseParams),
    ]);

    const inputLocation: FlatLocation = {
      filePath: absoluteFilePath,
      startLine: position.line + 1,
      startCharacter: position.character + 1,
      endLine: position.line + 1,
      endCharacter: position.character + 1,
    };

    const definition = extractLocations(definitionRaw)[0];
    const declaration = extractLocations(declarationRaw)[0];
    const lineCache = new Map<string, string[] | null>();

    const entries: SummaryEntry[] = [];
    const structuredEntries: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const appendEntry = async (location: FlatLocation, label: string): Promise<void> => {
      const key = `${label}:${locationKey(location)}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const lineText = await readLineTextFromFile(location.filePath, location.startLine, lineCache);
      const cleanedLine = lineText.trim().length > 0 ? lineText.trim() : label;
      const path = locationToSummaryPath(location);
      entries.push({
        location: path,
        summary: `${label}: ${cleanedLine}`,
      });
      structuredEntries.push({
        label,
        location: {
          path,
          filePath: location.filePath,
          startLine: location.startLine,
          startCharacter: location.startCharacter,
          endLine: location.endLine,
          endCharacter: location.endCharacter,
        },
        line: cleanedLine,
      });
    };

    await appendEntry(inputLocation, 'query');
    if (definition) {
      await appendEntry(definition, 'definition');
    }
    if (declaration) {
      await appendEntry(declaration, 'declaration');
    }

    const sections: string[] = [];
    const hoverText = flattenHoverText(hoverRaw).trim();
    if (hoverText.length > 0) {
      sections.push(renderSection('HOVER', hoverText));
    }
    const signature = extractActiveSignatureLabel(signatureRaw).trim();
    if (signature.length > 0) {
      sections.push(renderSection('SIGNATURE', signature));
    }

    const snippetCandidates: Array<{ location: FlatLocation; source: 'definition' | 'declaration' }> = [];
    if (definition) {
      snippetCandidates.push({ location: definition, source: 'definition' });
    }
    if (declaration) {
      snippetCandidates.push({ location: declaration, source: 'declaration' });
    }
    const filteredSnippetCandidates = snippetCandidates.filter((candidate) => !isGeneratedSourcePath(candidate.location.filePath));
    const snippetCandidate = filteredSnippetCandidates[0];
    const snippetLocation = snippetCandidate?.location;
    const snippetSource: 'definition' | 'declaration' | 'none' = snippetCandidate?.source ?? 'none';
    const snippetFilteredGenerated = snippetCandidates.length > 0 && filteredSnippetCandidates.length === 0;
    let snippetContent: string | undefined;
    if (includeSnippet && snippetLocation) {
      const snippetText = await readSnippetFromFile(
        snippetLocation.filePath,
        snippetLocation.startLine,
        snippetMaxLines,
        lineCache,
      );
      if (snippetText.length > 0) {
        snippetContent = snippetText;
        sections.push(renderSection('SNIPPET', snippetText));
      }
    }

    const counts = {
      total: entries.length,
      shown: entries.length,
      truncated: false,
      kind: 'symbolInfo',
    };
    const text = renderSummaryText(counts, entries, sections);

    return successTextResult(text, {
      kind: 'symbolInfo',
      counts: {
        total: counts.total,
        shown: counts.shown,
        truncated: counts.truncated,
      },
      entries: structuredEntries,
      hover: hoverText.length > 0 ? hoverText : undefined,
      signature: signature.length > 0 ? signature : undefined,
      snippet: snippetContent,
      snippetSource,
      snippetFilteredGenerated,
    });
  } catch (error) {
    return errorResult(error);
  }
}
