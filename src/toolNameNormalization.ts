export const LM_TOOL_NAME_PREFIX = 'lm_';

export interface RawVsCodeToolInfo {
  name: string;
  description?: string;
  tags?: readonly string[];
  inputSchema?: unknown;
}

export interface NormalizedVsCodeToolInfo {
  name: string;
  sourceName: string;
  description?: string;
  tags: readonly string[];
  inputSchema?: unknown;
}

export interface NormalizedVsCodeToolCollision {
  sourceName: string;
  exposedName: string;
  reason: 'reserved-name' | 'duplicate-exposed-name';
  existingSourceName?: string;
}

export function toNormalizedVsCodeToolName(sourceName: string): string {
  const trimmed = sourceName.trim();
  if (trimmed.length === 0 || trimmed.startsWith(LM_TOOL_NAME_PREFIX)) {
    return trimmed;
  }
  return `${LM_TOOL_NAME_PREFIX}${trimmed}`;
}

export function buildLegacyToNormalizedToolNameMap(sourceNames: readonly string[]): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const sourceName of sourceNames) {
    const trimmed = sourceName.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const normalized = toNormalizedVsCodeToolName(trimmed);
    if (normalized !== trimmed) {
      entries.set(trimmed, normalized);
    }
  }
  return entries;
}

export function migrateToolName(name: string, legacyMap: ReadonlyMap<string, string>): string {
  const trimmed = name.trim();
  return legacyMap.get(trimmed) ?? trimmed;
}

export function migrateToolNameList(
  names: readonly string[],
  legacyMap: ReadonlyMap<string, string>,
): { values: string[]; changed: boolean } {
  let changed = false;
  const values = names.map((name) => {
    const migrated = migrateToolName(name, legacyMap);
    if (migrated !== name) {
      changed = true;
    }
    return migrated;
  });
  return { values, changed };
}

export function migrateSchemaDefaultOverrideEntry(
  entry: string,
  legacyMap: ReadonlyMap<string, string>,
): string {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return entry;
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex <= 0 || equalsIndex === trimmed.length - 1) {
    return entry;
  }
  const key = trimmed.slice(0, equalsIndex).trim();
  const rawValue = trimmed.slice(equalsIndex + 1).trim();
  const parts = key.split('.');
  if (parts.length !== 2) {
    return entry;
  }
  const toolName = parts[0]?.trim();
  const paramName = parts[1]?.trim();
  if (!toolName || !paramName || rawValue.length === 0) {
    return entry;
  }
  const migratedToolName = migrateToolName(toolName, legacyMap);
  if (migratedToolName === toolName) {
    return entry;
  }
  return `${migratedToolName}.${paramName}=${rawValue}`;
}

export function migrateSchemaDefaultOverrideEntries(
  entries: readonly unknown[],
  legacyMap: ReadonlyMap<string, string>,
): { values: unknown[]; changed: boolean } {
  let changed = false;
  const values = entries.map((entry) => {
    if (typeof entry !== 'string') {
      return entry;
    }
    const migrated = migrateSchemaDefaultOverrideEntry(entry, legacyMap);
    if (migrated !== entry) {
      changed = true;
    }
    return migrated;
  });
  return { values, changed };
}

function getFamilyPrefix(name: string): string | undefined {
  const underscoreIndex = name.indexOf('_');
  if (underscoreIndex <= 0) {
    return undefined;
  }
  return name.slice(0, underscoreIndex + 1);
}

export function detectLikelyLegacyGroupingRuleFragments(
  pattern: string,
  legacyMap: ReadonlyMap<string, string>,
): string[] {
  const matches = new Set<string>();

  for (const [legacyName, normalizedName] of legacyMap.entries()) {
    if (pattern.includes(legacyName) && !pattern.includes(normalizedName)) {
      matches.add(legacyName);
    }
  }

  const familyPrefixes = new Set<string>();
  for (const legacyName of legacyMap.keys()) {
    const prefix = getFamilyPrefix(legacyName);
    if (prefix) {
      familyPrefixes.add(prefix);
    }
  }

  for (const legacyPrefix of familyPrefixes) {
    const normalizedPrefix = `${LM_TOOL_NAME_PREFIX}${legacyPrefix}`;
    if (pattern.includes(legacyPrefix) && !pattern.includes(normalizedPrefix)) {
      matches.add(legacyPrefix);
    }
  }

  return [...matches].sort((left, right) => left.localeCompare(right));
}

function shouldPreferCurrentTool(
  existing: NormalizedVsCodeToolInfo,
  current: NormalizedVsCodeToolInfo,
): boolean {
  if (existing.sourceName === existing.name && current.sourceName !== current.name) {
    return false;
  }
  if (existing.sourceName !== existing.name && current.sourceName === current.name) {
    return true;
  }
  return false;
}

export function normalizeVsCodeToolInfos(
  tools: readonly RawVsCodeToolInfo[],
  reservedExposedNames: ReadonlySet<string>,
): {
  tools: NormalizedVsCodeToolInfo[];
  collisions: NormalizedVsCodeToolCollision[];
} {
  const normalizedByName = new Map<string, NormalizedVsCodeToolInfo>();
  const collisions: NormalizedVsCodeToolCollision[] = [];

  for (const tool of tools) {
    const sourceName = tool.name.trim();
    if (sourceName.length === 0) {
      continue;
    }
    const exposedName = toNormalizedVsCodeToolName(sourceName);
    const normalized: NormalizedVsCodeToolInfo = {
      name: exposedName,
      sourceName,
      description: tool.description,
      tags: [...(tool.tags ?? [])],
      inputSchema: tool.inputSchema,
    };

    if (reservedExposedNames.has(exposedName)) {
      collisions.push({
        sourceName,
        exposedName,
        reason: 'reserved-name',
      });
      continue;
    }

    const existing = normalizedByName.get(exposedName);
    if (!existing) {
      normalizedByName.set(exposedName, normalized);
      continue;
    }

    if (shouldPreferCurrentTool(existing, normalized)) {
      normalizedByName.set(exposedName, normalized);
      collisions.push({
        sourceName: existing.sourceName,
        exposedName,
        reason: 'duplicate-exposed-name',
        existingSourceName: normalized.sourceName,
      });
      continue;
    }

    collisions.push({
      sourceName: normalized.sourceName,
      exposedName,
      reason: 'duplicate-exposed-name',
      existingSourceName: existing.sourceName,
    });
  }

  return {
    tools: [...normalizedByName.values()],
    collisions,
  };
}
