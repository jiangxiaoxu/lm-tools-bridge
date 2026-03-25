import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyToNormalizedToolNameMap,
  detectLikelyLegacyGroupingRuleFragments,
  migrateSchemaDefaultOverrideEntries,
  migrateSchemaDefaultOverrideEntry,
  migrateToolNameList,
  normalizeVsCodeToolInfos,
  toNormalizedVsCodeToolName,
} from '../toolNameNormalization';

test('toNormalizedVsCodeToolName prefixes non-lm tool names', () => {
  assert.equal(toNormalizedVsCodeToolName('copilot_searchCodebase'), 'lm_copilot_searchCodebase');
  assert.equal(toNormalizedVsCodeToolName('lm_findFiles'), 'lm_findFiles');
});

test('buildLegacyToNormalizedToolNameMap collects only legacy names', () => {
  const mapping = buildLegacyToNormalizedToolNameMap([
    'copilot_searchCodebase',
    'lm_findFiles',
    'getVSCodeWorkspace',
  ]);

  assert.deepEqual([...mapping.entries()], [
    ['copilot_searchCodebase', 'lm_copilot_searchCodebase'],
    ['getVSCodeWorkspace', 'lm_getVSCodeWorkspace'],
  ]);
});

test('normalizeVsCodeToolInfos prefixes names and skips reserved custom collisions', () => {
  const normalized = normalizeVsCodeToolInfos(
    [
      { name: 'copilot_searchCodebase', description: 'Legacy copilot tool.' },
      { name: 'lm_customAlreadyNormalized', description: 'Already normalized.' },
      { name: 'customTool', description: 'Would conflict with a custom tool after normalization.' },
    ],
    new Set(['lm_customTool']),
  );

  assert.deepEqual(
    normalized.tools.map((tool) => ({ name: tool.name, sourceName: tool.sourceName })),
    [
      { name: 'lm_copilot_searchCodebase', sourceName: 'copilot_searchCodebase' },
      { name: 'lm_customAlreadyNormalized', sourceName: 'lm_customAlreadyNormalized' },
    ],
  );
  assert.deepEqual(normalized.collisions, [
    {
      sourceName: 'customTool',
      exposedName: 'lm_customTool',
      reason: 'reserved-name',
    },
  ]);
});

test('normalizeVsCodeToolInfos prefers an already-normalized vscode tool over a rewritten duplicate', () => {
  const normalized = normalizeVsCodeToolInfos(
    [
      { name: 'foo', description: 'Legacy foo.' },
      { name: 'lm_foo', description: 'Already normalized foo.' },
    ],
    new Set<string>(),
  );

  assert.deepEqual(
    normalized.tools.map((tool) => ({ name: tool.name, sourceName: tool.sourceName })),
    [
      { name: 'lm_foo', sourceName: 'lm_foo' },
    ],
  );
  assert.deepEqual(normalized.collisions, [
    {
      sourceName: 'foo',
      exposedName: 'lm_foo',
      reason: 'duplicate-exposed-name',
      existingSourceName: 'lm_foo',
    },
  ]);
});

test('migrateToolNameList rewrites legacy exact-name configs', () => {
  const mapping = buildLegacyToNormalizedToolNameMap([
    'copilot_searchCodebase',
    'getVSCodeWorkspace',
  ]);

  const migrated = migrateToolNameList(
    ['copilot_searchCodebase', 'lm_findFiles', 'getVSCodeWorkspace'],
    mapping,
  );

  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.values, [
    'lm_copilot_searchCodebase',
    'lm_findFiles',
    'lm_getVSCodeWorkspace',
  ]);
});

test('migrateSchemaDefaultOverrideEntry rewrites only the tool name segment', () => {
  const mapping = buildLegacyToNormalizedToolNameMap(['copilot_searchCodebase']);

  assert.equal(
    migrateSchemaDefaultOverrideEntry('copilot_searchCodebase.maxResults=200', mapping),
    'lm_copilot_searchCodebase.maxResults=200',
  );
  assert.equal(
    migrateSchemaDefaultOverrideEntry('lm_findFiles.maxResults=200', mapping),
    'lm_findFiles.maxResults=200',
  );
  assert.equal(
    migrateSchemaDefaultOverrideEntry('invalid-entry', mapping),
    'invalid-entry',
  );
});

test('migrateSchemaDefaultOverrideEntries preserves non-string values while rewriting legacy tool names', () => {
  const mapping = buildLegacyToNormalizedToolNameMap(['copilot_searchCodebase']);
  const migrated = migrateSchemaDefaultOverrideEntries(
    ['copilot_searchCodebase.maxResults=200', 123, 'lm_findFiles.maxResults=100'],
    mapping,
  );

  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.values, [
    'lm_copilot_searchCodebase.maxResults=200',
    123,
    'lm_findFiles.maxResults=100',
  ]);
});

test('detectLikelyLegacyGroupingRuleFragments flags legacy exact names and prefixes', () => {
  const mapping = buildLegacyToNormalizedToolNameMap([
    'copilot_searchCodebase',
    'copilot_searchWorkspaceSymbols',
    'angelscript_run',
  ]);

  assert.deepEqual(
    detectLikelyLegacyGroupingRuleFragments('^copilot_|copilot_searchCodebase|^angelscript_', mapping),
    ['angelscript_', 'copilot_', 'copilot_searchCodebase'],
  );
  assert.deepEqual(
    detectLikelyLegacyGroupingRuleFragments('^lm_copilot_|lm_copilot_searchCodebase', mapping),
    [],
  );
});
