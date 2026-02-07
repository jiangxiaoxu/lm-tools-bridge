export type ToolGroupId = string;
export type ToolGroupParentId = 'builtin_disabled';
export type GroupCheckedState = 'checked' | 'partial' | 'unchecked';

export interface CompiledToolGroupingRule {
  id: string;
  label: string;
  groupId: ToolGroupId;
  disabledGroupId: ToolGroupId;
  matcher: RegExp;
}

export interface GroupedToolInput {
  name: string;
  description: string;
  tags: readonly string[];
  picked: boolean;
  readOnly?: boolean;
  builtInDisabled?: boolean;
  disabledGroupId?: ToolGroupId;
  isCustom: boolean;
}

export interface GroupedToolItem {
  name: string;
  description: string;
  tags: string[];
  picked: boolean;
  readOnly: boolean;
  groupId: ToolGroupId;
}

export interface GroupedToolSection {
  groupId: ToolGroupId;
  label: string;
  parentId?: ToolGroupParentId;
  parentLabel?: string;
  checkedState: GroupCheckedState;
  items: GroupedToolItem[];
}

export interface BuildGroupedToolSectionsOptions {
  customRules?: readonly CompiledToolGroupingRule[];
}

const GROUP_CUSTOM = 'custom';
const GROUP_COPILOT = 'copilot';
const GROUP_VSCODE = 'vscode';
const GROUP_OTHER = 'other';
const GROUP_BUILTIN_DISABLED_COPILOT = 'builtin_disabled_copilot';
const GROUP_BUILTIN_DISABLED_VSCODE = 'builtin_disabled_vscode';
const GROUP_BUILTIN_DISABLED_CUSTOM = 'builtin_disabled_custom';
const GROUP_BUILTIN_DISABLED_OTHER = 'builtin_disabled_other';
const BUILTIN_DISABLED_PARENT_LABEL = 'Built-in Disabled';

const BASE_GROUP_ORDER: readonly ToolGroupId[] = [
  GROUP_CUSTOM,
  GROUP_COPILOT,
  GROUP_VSCODE,
  GROUP_OTHER,
];
const BASE_DISABLED_GROUP_ORDER: readonly ToolGroupId[] = [
  GROUP_BUILTIN_DISABLED_COPILOT,
  GROUP_BUILTIN_DISABLED_VSCODE,
  GROUP_BUILTIN_DISABLED_CUSTOM,
  GROUP_BUILTIN_DISABLED_OTHER,
];

function buildRuleMaps(customRules: readonly CompiledToolGroupingRule[]) {
  const customRuleGroupOrder = customRules.map((rule) => rule.groupId);
  const customRuleDisabledGroupOrder = customRules.map((rule) => rule.disabledGroupId);
  const customLabelByGroupId = new Map<ToolGroupId, string>();
  const customGroupToDisabledGroup = new Map<ToolGroupId, ToolGroupId>();
  for (const rule of customRules) {
    customLabelByGroupId.set(rule.groupId, rule.label);
    customLabelByGroupId.set(rule.disabledGroupId, rule.label);
    customGroupToDisabledGroup.set(rule.groupId, rule.disabledGroupId);
  }
  return {
    customRuleGroupOrder,
    customRuleDisabledGroupOrder,
    customLabelByGroupId,
    customGroupToDisabledGroup,
  };
}

function toBuiltInDisabledGroupId(
  groupId: ToolGroupId,
  customGroupToDisabledGroup: ReadonlyMap<ToolGroupId, ToolGroupId>,
): ToolGroupId {
  const customGroup = customGroupToDisabledGroup.get(groupId);
  if (customGroup) {
    return customGroup;
  }
  switch (groupId) {
    case GROUP_CUSTOM:
      return GROUP_BUILTIN_DISABLED_CUSTOM;
    case GROUP_COPILOT:
      return GROUP_BUILTIN_DISABLED_COPILOT;
    case GROUP_VSCODE:
      return GROUP_BUILTIN_DISABLED_VSCODE;
    case GROUP_OTHER:
      return GROUP_BUILTIN_DISABLED_OTHER;
    default:
      return GROUP_BUILTIN_DISABLED_OTHER;
  }
}

function getCustomRuleGroupId(
  input: GroupedToolInput,
  customRules: readonly CompiledToolGroupingRule[],
): ToolGroupId | undefined {
  for (const rule of customRules) {
    if (rule.matcher.test(input.name)) {
      return rule.groupId;
    }
  }
  return undefined;
}

function classifyToolSource(
  input: GroupedToolInput,
  customRules: readonly CompiledToolGroupingRule[],
  customGroupToDisabledGroup: ReadonlyMap<ToolGroupId, ToolGroupId>,
): ToolGroupId {
  if (input.builtInDisabled === true) {
    if (input.disabledGroupId) {
      return input.disabledGroupId;
    }
    const baseGroupId = classifyToolSource(
      {
        ...input,
        builtInDisabled: false,
        disabledGroupId: undefined,
      },
      customRules,
      customGroupToDisabledGroup,
    );
    return toBuiltInDisabledGroupId(baseGroupId, customGroupToDisabledGroup);
  }

  const customRuleGroupId = getCustomRuleGroupId(input, customRules);
  if (customRuleGroupId) {
    return customRuleGroupId;
  }
  if (input.isCustom) {
    return GROUP_CUSTOM;
  }
  if (input.name.startsWith('copilot_')) {
    return GROUP_COPILOT;
  }
  if (input.name.length > 0) {
    return GROUP_VSCODE;
  }
  return GROUP_OTHER;
}

function getGroupLabel(groupId: ToolGroupId, customLabelByGroupId: ReadonlyMap<ToolGroupId, string>): string {
  const customLabel = customLabelByGroupId.get(groupId);
  if (customLabel) {
    return customLabel;
  }
  switch (groupId) {
    case GROUP_CUSTOM:
      return 'Custom tools';
    case GROUP_COPILOT:
      return 'Copilot tools';
    case GROUP_VSCODE:
      return 'VS Code tools';
    case GROUP_BUILTIN_DISABLED_COPILOT:
      return 'Copilot';
    case GROUP_BUILTIN_DISABLED_VSCODE:
      return 'VS Code';
    case GROUP_BUILTIN_DISABLED_CUSTOM:
      return 'Custom';
    case GROUP_BUILTIN_DISABLED_OTHER:
      return 'Other';
    default:
      return 'Other tools';
  }
}

function getGroupParent(
  groupId: ToolGroupId,
  disabledGroupSet: ReadonlySet<ToolGroupId>,
): { id: ToolGroupParentId; label: string } | undefined {
  if (disabledGroupSet.has(groupId)) {
    return { id: 'builtin_disabled', label: BUILTIN_DISABLED_PARENT_LABEL };
  }
  return undefined;
}

function computeGroupCheckedState(items: readonly GroupedToolItem[]): GroupCheckedState {
  if (items.length === 0) {
    return 'unchecked';
  }
  let checked = 0;
  for (const item of items) {
    if (item.picked) {
      checked += 1;
    }
  }
  if (checked === 0) {
    return 'unchecked';
  }
  if (checked === items.length) {
    return 'checked';
  }
  return 'partial';
}

export function buildGroupedToolSections(
  inputs: readonly GroupedToolInput[],
  options?: BuildGroupedToolSectionsOptions,
): GroupedToolSection[] {
  const customRules = options?.customRules ?? [];
  const {
    customRuleGroupOrder,
    customRuleDisabledGroupOrder,
    customLabelByGroupId,
    customGroupToDisabledGroup,
  } = buildRuleMaps(customRules);
  const groupOrder = [...customRuleGroupOrder, ...BASE_GROUP_ORDER];
  const disabledGroupOrder = [...customRuleDisabledGroupOrder, ...BASE_DISABLED_GROUP_ORDER];
  const orderedGroupIds = [...groupOrder, ...disabledGroupOrder];

  const disabledGroupSet = new Set<ToolGroupId>(disabledGroupOrder);
  const grouped = new Map<ToolGroupId, GroupedToolItem[]>();
  for (const groupId of orderedGroupIds) {
    grouped.set(groupId, []);
  }

  const extraGroupIds: ToolGroupId[] = [];
  for (const input of inputs) {
    const groupId = classifyToolSource(input, customRules, customGroupToDisabledGroup);
    if (!grouped.has(groupId)) {
      grouped.set(groupId, []);
      extraGroupIds.push(groupId);
      if (input.builtInDisabled === true) {
        disabledGroupSet.add(groupId);
      }
    }
    const list = grouped.get(groupId);
    if (!list) {
      continue;
    }
    list.push({
      name: input.name,
      description: input.description,
      tags: [...input.tags],
      picked: input.picked,
      readOnly: input.readOnly === true,
      groupId,
    });
  }

  const sections: GroupedToolSection[] = [];
  for (const groupId of [...orderedGroupIds, ...extraGroupIds]) {
    const items = grouped.get(groupId) ?? [];
    if (items.length === 0) {
      continue;
    }
    const parent = getGroupParent(groupId, disabledGroupSet);
    sections.push({
      groupId,
      label: getGroupLabel(groupId, customLabelByGroupId),
      parentId: parent?.id,
      parentLabel: parent?.label,
      checkedState: computeGroupCheckedState(items),
      items: items.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  return sections;
}
