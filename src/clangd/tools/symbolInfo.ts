import * as vscode from 'vscode';
import {
  DECLARATION_METHOD,
  DEFINITION_METHOD,
  DOCUMENT_SYMBOL_METHOD,
  HOVER_METHOD,
  SIGNATURE_HELP_METHOD,
  TYPE_DEFINITION_METHOD,
} from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSection, renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import {
  locationToSummaryPath,
  readLineTextFromFile,
  readSnippetFromFile,
  toStructuredLocation,
  toTextDocumentPositionParams,
  extractLocations,
  type FlatLocation,
} from './aiCommon';
import { errorResult, successTextResult } from './shared';

type SymbolCategory = 'callable' | 'valueLike' | 'typeLike' | 'namespaceLike' | 'unknown';

interface RawLspPosition {
  line?: unknown;
  character?: unknown;
}

interface RawLspRange {
  start?: RawLspPosition;
  end?: RawLspPosition;
}

interface RawDocumentSymbol {
  name?: unknown;
  kind?: unknown;
  range?: RawLspRange;
  children?: unknown;
}

interface RawLspLocation {
  uri?: unknown;
  range?: RawLspRange;
}

interface RawSymbolInformation {
  name?: unknown;
  kind?: unknown;
  location?: RawLspLocation;
}

interface SymbolMeta {
  category: SymbolCategory;
  kind?: number;
  name?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function rangeContainsPosition(range: RawLspRange | undefined, position: { line: number; character: number }): boolean {
  const startLine = toInteger(range?.start?.line);
  const startCharacter = toInteger(range?.start?.character);
  const endLine = toInteger(range?.end?.line);
  const endCharacter = toInteger(range?.end?.character);
  if (startLine === undefined || startCharacter === undefined || endLine === undefined || endCharacter === undefined) {
    return false;
  }
  if (position.line < startLine || position.line > endLine) {
    return false;
  }
  if (position.line === startLine && position.character < startCharacter) {
    return false;
  }
  if (position.line === endLine && position.character > endCharacter) {
    return false;
  }
  return true;
}

function rangeSpanScore(range: RawLspRange | undefined): number {
  const startLine = toInteger(range?.start?.line);
  const startCharacter = toInteger(range?.start?.character);
  const endLine = toInteger(range?.end?.line);
  const endCharacter = toInteger(range?.end?.character);
  if (startLine === undefined || startCharacter === undefined || endLine === undefined || endCharacter === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (endLine - startLine) * 10000 + (endCharacter - startCharacter);
}

function symbolKindToCategory(kind: number | undefined): SymbolCategory {
  if (kind === undefined) {
    return 'unknown';
  }
  if (kind === 6 || kind === 9 || kind === 12 || kind === 24 || kind === 25) {
    return 'callable';
  }
  if (kind === 7 || kind === 8 || kind === 13 || kind === 14 || kind === 22) {
    return 'valueLike';
  }
  if (kind === 5 || kind === 10 || kind === 11 || kind === 23 || kind === 26) {
    return 'typeLike';
  }
  if (kind === 1 || kind === 2 || kind === 3 || kind === 4) {
    return 'namespaceLike';
  }
  return 'unknown';
}

function collectDocumentSymbolMatches(
  value: unknown,
  position: { line: number; character: number },
): Array<{ kind?: number; name?: string; range?: RawLspRange }> {
  const results: Array<{ kind?: number; name?: string; range?: RawLspRange }> = [];
  const visit = (entry: RawDocumentSymbol): void => {
    if (rangeContainsPosition(entry.range, position)) {
      results.push({
        kind: toInteger(entry.kind),
        name: typeof entry.name === 'string' ? entry.name : undefined,
        range: entry.range,
      });
    }
    const children = Array.isArray(entry.children) ? entry.children : [];
    for (const child of children) {
      const record = asRecord(child) as RawDocumentSymbol | undefined;
      if (record) {
        visit(record);
      }
    }
  };

  if (!Array.isArray(value)) {
    return results;
  }
  for (const item of value) {
    const record = asRecord(item) as RawDocumentSymbol | undefined;
    if (record && (record.range || record.children)) {
      visit(record);
    }
  }
  return results;
}

function collectSymbolInformationMatches(
  value: unknown,
  position: { line: number; character: number },
  uri: string,
): Array<{ kind?: number; name?: string; range?: RawLspRange }> {
  const results: Array<{ kind?: number; name?: string; range?: RawLspRange }> = [];
  if (!Array.isArray(value)) {
    return results;
  }
  for (const item of value) {
    const record = asRecord(item) as RawSymbolInformation | undefined;
    if (!record) {
      continue;
    }
    const location = record.location;
    if (!location || typeof location.uri !== 'string' || location.uri !== uri) {
      continue;
    }
    if (!rangeContainsPosition(location.range, position)) {
      continue;
    }
    results.push({
      kind: toInteger(record.kind),
      name: typeof record.name === 'string' ? record.name : undefined,
      range: location.range,
    });
  }
  return results;
}

async function resolveSymbolMeta(
  uri: string,
  position: { line: number; character: number },
): Promise<SymbolMeta> {
  try {
    const raw = await sendRequestWithAutoStart<unknown>(DOCUMENT_SYMBOL_METHOD, {
      textDocument: { uri },
    });
    let matches = collectDocumentSymbolMatches(raw, position);
    if (matches.length === 0) {
      matches = collectSymbolInformationMatches(raw, position, uri);
    }
    if (matches.length === 0) {
      return { category: 'unknown' };
    }
    matches.sort((left, right) => rangeSpanScore(left.range) - rangeSpanScore(right.range));
    const selected = matches[0];
    return {
      category: symbolKindToCategory(selected.kind),
      kind: selected.kind,
      name: selected.name,
    };
  } catch {
    return { category: 'unknown' };
  }
}

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

function sameLocation(left: FlatLocation | undefined, right: FlatLocation | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return locationKey(left) === locationKey(right);
}

function shouldIncludeTypeDefinition(
  category: SymbolCategory,
  typeDefinition: FlatLocation | undefined,
  definition: FlatLocation | undefined,
  declaration: FlatLocation | undefined,
): boolean {
  if (!typeDefinition) {
    return false;
  }
  if (sameLocation(typeDefinition, definition) || sameLocation(typeDefinition, declaration)) {
    return false;
  }
  if (category === 'valueLike') {
    return true;
  }
  if (category === 'unknown') {
    return true;
  }
  return false;
}

function shouldIncludeHover(category: SymbolCategory): boolean {
  return category !== 'namespaceLike';
}

function isLikelyCallableSignature(signature: string): boolean {
  return signature.includes('(') && signature.includes(')');
}

function shouldIncludeSignature(category: SymbolCategory, signature: string): boolean {
  if (!signature) {
    return false;
  }
  if (category === 'callable') {
    return true;
  }
  if (category === 'unknown') {
    return isLikelyCallableSignature(signature);
  }
  return false;
}

function shouldIncludeSnippet(category: SymbolCategory): boolean {
  return category === 'callable' || category === 'typeLike';
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
    const { uri, position } = toTextDocumentPositionParams(input);
    const includeSnippet = parseIncludeSnippet(input.includeSnippet);
    const snippetMaxLines = parseSnippetMaxLines(input.snippetMaxLines);

    const baseParams = {
      textDocument: { uri },
      position,
    };

    const [definitionRaw, declarationRaw, hoverRaw, signatureRaw, symbolMeta] = await Promise.all([
      sendRequestWithAutoStart<unknown>(DEFINITION_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(DECLARATION_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(HOVER_METHOD, baseParams),
      sendRequestWithAutoStart<unknown>(SIGNATURE_HELP_METHOD, baseParams),
      resolveSymbolMeta(uri, position),
    ]);

    const definition = extractLocations(definitionRaw)[0];
    const rawDeclaration = extractLocations(declarationRaw)[0];
    const declaration = sameLocation(rawDeclaration, definition) ? undefined : rawDeclaration;
    let typeDefinition: FlatLocation | undefined;
    if (symbolMeta.category === 'valueLike' || symbolMeta.category === 'unknown') {
      const typeDefinitionRaw = await sendRequestWithAutoStart<unknown>(TYPE_DEFINITION_METHOD, baseParams);
      typeDefinition = extractLocations(typeDefinitionRaw)[0];
    }
    const includeTypeDefinition = shouldIncludeTypeDefinition(symbolMeta.category, typeDefinition, definition, declaration);
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
        location: toStructuredLocation(location, cleanedLine),
      });
    };

    if (definition) {
      await appendEntry(definition, 'definition');
    }
    if (includeTypeDefinition && typeDefinition) {
      await appendEntry(typeDefinition, 'typeDefinition');
    }
    if (declaration) {
      await appendEntry(declaration, 'declaration');
    }

    const sections: string[] = [];
    const hoverText = flattenHoverText(hoverRaw).trim();
    if (hoverText.length > 0 && shouldIncludeHover(symbolMeta.category)) {
      sections.push(renderSection('HOVER', hoverText));
    }
    const signature = extractActiveSignatureLabel(signatureRaw).trim();
    if (shouldIncludeSignature(symbolMeta.category, signature)) {
      sections.push(renderSection('SIGNATURE', signature));
    }

    const snippetCandidates: Array<{ location: FlatLocation; source: 'definition' | 'declaration' }> = [];
    if (shouldIncludeSnippet(symbolMeta.category)) {
      if (definition) {
        snippetCandidates.push({ location: definition, source: 'definition' });
      }
      if (declaration) {
        snippetCandidates.push({ location: declaration, source: 'declaration' });
      }
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
      extras: {
        symbolCategory: symbolMeta.category,
      },
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
      symbolCategory: symbolMeta.category,
      symbolKind: symbolMeta.kind,
      symbolName: symbolMeta.name,
      hover: hoverText.length > 0 ? hoverText : undefined,
      signature: shouldIncludeSignature(symbolMeta.category, signature) ? signature : undefined,
      snippet: snippetContent,
      snippetSource,
      snippetFilteredGenerated,
    });
  } catch (error) {
    return errorResult(error);
  }
}
