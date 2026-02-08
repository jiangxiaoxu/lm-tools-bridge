import * as vscode from 'vscode';
import {
  CALL_HIERARCHY_INCOMING_METHOD,
  CALL_HIERARCHY_OUTGOING_METHOD,
  PREPARE_CALL_HIERARCHY_METHOD,
} from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSection, renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import {
  extractLocations,
  locationToSummaryPath,
  parseLimit,
  readLineTextFromFile,
  toStructuredLocation,
  toTextDocumentPositionParams,
  type FlatLocation,
} from './aiCommon';
import { ClangdToolError } from '../errors';
import { errorResult, successTextResult } from './shared';

interface RawCallHierarchyItem {
  name?: unknown;
  uri?: unknown;
  range?: {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
}

interface TraversalNode {
  item: RawCallHierarchyItem;
  depth: number;
}

interface CallHierarchyEdge {
  location: FlatLocation;
  summary: string;
  preview: string;
}

function normalizeDirection(value: unknown): 'incoming' | 'outgoing' | 'both' {
  if (value === undefined) {
    return 'both';
  }
  if (value === 'incoming' || value === 'outgoing' || value === 'both') {
    return value;
  }
  throw new ClangdToolError('INVALID_INPUT', "Expected 'direction' to be incoming, outgoing, or both.");
}

function getItemName(item: RawCallHierarchyItem): string {
  return typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : 'Unknown';
}

function itemKey(item: RawCallHierarchyItem): string {
  const name = getItemName(item);
  const uri = typeof item.uri === 'string' ? item.uri : '';
  const line = item.range?.start?.line;
  const character = item.range?.start?.character;
  return `${uri}|${line}|${character}|${name}`;
}

function toLocation(item: RawCallHierarchyItem) {
  if (typeof item.uri !== 'string' || !item.range || typeof item.range !== 'object') {
    return undefined;
  }
  const locations = extractLocations({
    uri: item.uri,
    range: item.range,
  });
  return locations[0];
}

export async function runCallHierarchyTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const { uri, position } = toTextDocumentPositionParams(input);
    const direction = normalizeDirection(input.direction);
    const maxDepth = parseLimit(input, 'maxDepth', 2, 6);
    const maxBreadth = parseLimit(input, 'maxBreadth', 20, 80);

    const preparedRaw = await sendRequestWithAutoStart<unknown>(PREPARE_CALL_HIERARCHY_METHOD, {
      textDocument: { uri },
      position,
    });

    const preparedItems = Array.isArray(preparedRaw) ? preparedRaw : [];
    const root = preparedItems.find((item) => item && typeof item === 'object' && !Array.isArray(item)) as RawCallHierarchyItem | undefined;
    if (!root) {
      const structured = {
        kind: 'callHierarchy',
        counts: {
          total: 0,
          shown: 0,
          truncated: false,
        },
        root: null,
        incoming: [] as Array<Record<string, unknown>>,
        outgoing: [] as Array<Record<string, unknown>>,
      };
      const text = renderSummaryText(
        {
          total: 0,
          shown: 0,
          truncated: false,
          kind: 'callHierarchy',
        },
        [],
        [renderSection('ROOT', '(none)')],
      );
      return successTextResult(text, structured);
    }

    const incomingEntries: SummaryEntry[] = [];
    const outgoingEntries: SummaryEntry[] = [];
    const incomingStructuredEdges: CallHierarchyEdge[] = [];
    const outgoingStructuredEdges: CallHierarchyEdge[] = [];
    const seenIncoming = new Set<string>();
    const seenOutgoing = new Set<string>();
    const lineCache = new Map<string, string[] | null>();
    let truncated = false;

    if (direction === 'incoming' || direction === 'both') {
      const queue: TraversalNode[] = [{ item: root, depth: 0 }];
      const visited = new Set<string>([itemKey(root)]);
      while (queue.length > 0) {
        const current = queue.shift() as TraversalNode;
        const rawIncoming = await sendRequestWithAutoStart<unknown>(CALL_HIERARCHY_INCOMING_METHOD, {
          item: current.item,
        });
        const calls = Array.isArray(rawIncoming) ? rawIncoming : [];
        if (calls.length > maxBreadth) {
          truncated = true;
        }
        const selectedCalls = calls.slice(0, maxBreadth);
        if (current.depth >= maxDepth && selectedCalls.length > 0) {
          truncated = true;
        }
        for (const call of selectedCalls) {
          if (!call || typeof call !== 'object' || Array.isArray(call)) {
            continue;
          }
          const record = call as Record<string, unknown>;
          const fromItem = (record.from && typeof record.from === 'object' && !Array.isArray(record.from))
            ? record.from as RawCallHierarchyItem
            : undefined;
          if (!fromItem) {
            continue;
          }
          const fromLocation = toLocation(fromItem);
          if (fromLocation) {
            const edgeKey = `${locationToSummaryPath(fromLocation)}=>${getItemName(current.item)}`;
            if (!seenIncoming.has(edgeKey)) {
              seenIncoming.add(edgeKey);
              const summary = `${getItemName(fromItem)} -> ${getItemName(current.item)}`;
              const preview = (await readLineTextFromFile(
                fromLocation.filePath,
                fromLocation.startLine,
                lineCache,
              )).trim();
              incomingEntries.push({
                location: locationToSummaryPath(fromLocation),
                summary,
              });
              incomingStructuredEdges.push({
                location: fromLocation,
                summary,
                preview,
              });
            }
          }
          if (current.depth < maxDepth) {
            const key = itemKey(fromItem);
            if (!visited.has(key)) {
              visited.add(key);
              queue.push({ item: fromItem, depth: current.depth + 1 });
            }
          }
        }
      }
    }

    if (direction === 'outgoing' || direction === 'both') {
      const queue: TraversalNode[] = [{ item: root, depth: 0 }];
      const visited = new Set<string>([itemKey(root)]);
      while (queue.length > 0) {
        const current = queue.shift() as TraversalNode;
        const rawOutgoing = await sendRequestWithAutoStart<unknown>(CALL_HIERARCHY_OUTGOING_METHOD, {
          item: current.item,
        });
        const calls = Array.isArray(rawOutgoing) ? rawOutgoing : [];
        if (calls.length > maxBreadth) {
          truncated = true;
        }
        const selectedCalls = calls.slice(0, maxBreadth);
        if (current.depth >= maxDepth && selectedCalls.length > 0) {
          truncated = true;
        }
        for (const call of selectedCalls) {
          if (!call || typeof call !== 'object' || Array.isArray(call)) {
            continue;
          }
          const record = call as Record<string, unknown>;
          const toItem = (record.to && typeof record.to === 'object' && !Array.isArray(record.to))
            ? record.to as RawCallHierarchyItem
            : undefined;
          if (!toItem) {
            continue;
          }
          const calleeLocation = toLocation(toItem);
          if (calleeLocation) {
            const edgeKey = `${getItemName(current.item)}=>${locationToSummaryPath(calleeLocation)}`;
            if (!seenOutgoing.has(edgeKey)) {
              seenOutgoing.add(edgeKey);
              const summary = `${getItemName(current.item)} -> ${getItemName(toItem)}`;
              const preview = (await readLineTextFromFile(
                calleeLocation.filePath,
                calleeLocation.startLine,
                lineCache,
              )).trim();
              outgoingEntries.push({
                location: locationToSummaryPath(calleeLocation),
                summary,
              });
              outgoingStructuredEdges.push({
                location: calleeLocation,
                summary,
                preview,
              });
            }
          }
          if (current.depth < maxDepth) {
            const key = itemKey(toItem);
            if (!visited.has(key)) {
              visited.add(key);
              queue.push({ item: toItem, depth: current.depth + 1 });
            }
          }
        }
      }
    }

    const rootLocation = toLocation(root);
    const sections: string[] = [
      renderSection(
        'ROOT',
        rootLocation
          ? `${locationToSummaryPath(rootLocation)}\n${getItemName(root)}`
          : getItemName(root),
      ),
      renderSection('INCOMING', incomingEntries.length > 0 ? incomingEntries.map((entry) => `${entry.location}\n${entry.summary}`).join('\n---\n') : '(none)'),
      renderSection('OUTGOING', outgoingEntries.length > 0 ? outgoingEntries.map((entry) => `${entry.location}\n${entry.summary}`).join('\n---\n') : '(none)'),
    ];

    const counts = {
      total: incomingEntries.length + outgoingEntries.length,
      shown: incomingEntries.length + outgoingEntries.length,
      truncated,
      kind: 'callHierarchy',
      extras: {
        direction,
        maxDepth,
        maxBreadth,
      },
    };
    const text = renderSummaryText(
      counts,
      [],
      sections,
    );

    const rootStructuredLocation = rootLocation
      ? toStructuredLocation(
        rootLocation,
        (await readLineTextFromFile(rootLocation.filePath, rootLocation.startLine, lineCache)).trim(),
      )
      : undefined;

    const incomingStructured = incomingStructuredEdges.map((entry) => ({
      location: toStructuredLocation(entry.location, entry.preview),
      summary: entry.summary,
    }));
    const outgoingStructured = outgoingStructuredEdges.map((entry) => ({
      location: toStructuredLocation(entry.location, entry.preview),
      summary: entry.summary,
    }));

    return successTextResult(text, {
      kind: 'callHierarchy',
      counts: {
        total: counts.total,
        shown: counts.shown,
        truncated: counts.truncated,
      },
      root: {
        name: getItemName(root),
        location: rootStructuredLocation,
      },
      incoming: incomingStructured,
      outgoing: outgoingStructured,
    });
  } catch (error) {
    return errorResult(error);
  }
}
