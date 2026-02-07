import * as vscode from 'vscode';
import type { GroupedToolSection } from './toolGrouping';

export type ToolConfigPanelMode = 'exposure' | 'enabled';
export type ToolConfigPanelResult =
  | { action: 'apply'; selected: string[] }
  | { action: 'reset' }
  | { action: 'cancel' };

export interface ShowToolConfigPanelOptions {
  mode: ToolConfigPanelMode;
  title: string;
  placeHolder: string;
  resetLabel: string;
  resetDescription: string;
  sections: GroupedToolSection[];
}

interface WebviewToolItem {
  name: string;
  description: string;
  tags: string[];
  selected: boolean;
  readOnly: boolean;
}

interface WebviewToolSection {
  id: string;
  label: string;
  parentId?: string;
  parentLabel?: string;
  collapsed: boolean;
  items: WebviewToolItem[];
}

interface WebviewInitPayload {
  mode: ToolConfigPanelMode;
  title: string;
  placeHolder: string;
  resetLabel: string;
  resetDescription: string;
  sections: WebviewToolSection[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodePayloadBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function toWebviewPayload(options: ShowToolConfigPanelOptions): WebviewInitPayload {
  return {
    mode: options.mode,
    title: options.title,
    placeHolder: options.placeHolder,
    resetLabel: options.resetLabel,
    resetDescription: options.resetDescription,
    sections: options.sections.map((section) => ({
      id: section.groupId,
      label: section.label,
      parentId: section.parentId,
      parentLabel: section.parentLabel,
      collapsed: false,
      items: section.items.map((item) => ({
        name: item.name,
        description: item.description,
        tags: [...item.tags],
        selected: item.picked,
        readOnly: item.readOnly === true,
      })),
    })),
  };
}

function buildWebviewHtml(payload: WebviewInitPayload): string {
  const stateBase64 = encodePayloadBase64(payload);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(payload.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto auto auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .toolbar input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }
    .toolbar .count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      padding: 0 4px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .hint {
      margin-bottom: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .tree {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .tree-block {
      border-top: 1px solid var(--vscode-panel-border);
    }
    .tree-block:first-child {
      border-top: none;
    }
    .group-parent-header {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
      font-weight: 600;
    }
    .group-parent-children {
      padding: 0 0 4px 0;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .nested-group {
      margin: 6px 8px 0 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .group {
      border-top: 1px solid var(--vscode-panel-border);
    }
    .group:first-child {
      border-top: none;
    }
    .group-header {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--vscode-sideBar-background);
    }
    .toggle {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 11px;
      padding: 0;
      width: 14px;
      height: 14px;
      line-height: 14px;
      text-align: center;
    }
    .group-title {
      font-weight: 600;
    }
    .group-count {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .tools {
      padding: 0 10px 8px 36px;
    }
    .tool {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 8px;
      padding: 6px 0;
      align-items: start;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .tool:first-child {
      border-top: none;
    }
    .tool-main {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .tool-name {
      font-size: 13px;
    }
    .tool-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .tool-tags {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .tool.readonly {
      opacity: 0.75;
    }
    .hidden {
      display: none !important;
    }
    .empty {
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="text" placeholder="${escapeHtml(payload.placeHolder)}" />
    <span id="count" class="count"></span>
    <button id="resetBtn" class="secondary" title="${escapeHtml(payload.resetDescription)}">${escapeHtml(payload.resetLabel)}</button>
    <button id="cancelBtn" class="secondary">Cancel</button>
    <button id="confirmBtn">Confirm</button>
  </div>
  <div class="hint">Use group checkboxes for batch selection. Selection applies globally after confirmation.</div>
  <div id="tree" class="tree"></div>
  <script>
    (() => {
      const vscodeApi = acquireVsCodeApi();
      function decodeState(base64Text) {
        try {
          const binary = atob(base64Text);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          const decoded = new TextDecoder().decode(bytes);
          return JSON.parse(decoded || '{}');
        } catch {
          return {};
        }
      }
      const initialState = decodeState('${stateBase64}');
      const initialSections = Array.isArray(initialState.sections) ? initialState.sections : [];
      const parentCollapsed = {};
      for (const section of initialSections) {
        if (section && typeof section.parentId === 'string' && !(section.parentId in parentCollapsed)) {
          parentCollapsed[section.parentId] = false;
        }
      }
      const state = {
        search: '',
        sections: initialSections,
        parentCollapsed,
      };

      const tree = document.getElementById('tree');
      const searchInput = document.getElementById('search');
      const countLabel = document.getElementById('count');
      const resetBtn = document.getElementById('resetBtn');
      const cancelBtn = document.getElementById('cancelBtn');
      const confirmBtn = document.getElementById('confirmBtn');

      function lower(value) {
        return (value || '').toLowerCase();
      }

      function escapeHtmlText(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function isToolMatched(tool, keyword) {
        if (!keyword) {
          return true;
        }
        const tags = Array.isArray(tool.tags) ? tool.tags.join(' ') : '';
        return lower(tool.name).includes(keyword)
          || lower(tool.description).includes(keyword)
          || lower(tags).includes(keyword);
      }

      function getAllItems() {
        const all = [];
        for (const section of state.sections) {
          for (const item of section.items) {
            all.push(item);
          }
        }
        return all;
      }

      function getSelectedCount() {
        let count = 0;
        for (const item of getAllItems()) {
          if (item.selected) {
            count += 1;
          }
        }
        return count;
      }

      function computeGroupState(items) {
        const editableItems = items.filter((item) => !item.readOnly);
        if (!editableItems.length) {
          return items.some((item) => item.selected) ? 'checked' : 'unchecked';
        }
        if (!items.length) {
          return 'unchecked';
        }
        const checked = editableItems.filter((item) => item.selected).length;
        if (checked === 0) {
          return 'unchecked';
        }
        if (checked === editableItems.length) {
          return 'checked';
        }
        return 'partial';
      }

      function updateCountLabel() {
        const selected = getSelectedCount();
        countLabel.textContent = 'Selected ' + selected + ' item(s)';
      }

      function buildToolRows(matchedItems) {
        return matchedItems.map((item) => {
          const escapedName = escapeHtmlText(item.name);
          const escapedDescription = escapeHtmlText(item.description);
          const checked = item.selected ? 'checked' : '';
          const disabled = item.readOnly ? 'disabled' : '';
          const toolClass = item.readOnly ? 'tool readonly' : 'tool';
          const readOnlyTitle = item.readOnly ? ' title="Read-only item"' : '';
          const tags = item.tags && item.tags.length > 0
            ? '<div class="tool-tags">' + escapeHtmlText(item.tags.join(', ')) + '</div>'
            : '';
          const desc = item.description
            ? '<div class="tool-desc">' + escapedDescription + '</div>'
            : '';
          return [
            '<label class="' + toolClass + '" data-tool-name="' + escapedName + '"' + readOnlyTitle + '>',
            '<input class="tool-checkbox" type="checkbox" data-tool-name="' + escapedName + '" ' + checked + ' ' + disabled + ' />',
            '<span class="tool-main">',
            '<span class="tool-name">' + escapedName + '</span>',
            desc,
            tags,
            '</span>',
            '</label>'
          ].join('');
        }).join('');
      }

      function buildSectionMarkup(sectionView, extraClass) {
        const section = sectionView.section;
        const matchedItems = sectionView.matchedItems;
        const groupState = sectionView.groupState;
        const groupChecked = groupState === 'checked' ? 'checked' : '';
        const hasEditableItems = section.items.some((item) => !item.readOnly);
        const groupDisabled = hasEditableItems ? '' : 'disabled';
        const toolRows = buildToolRows(matchedItems);
        const collapsedClass = section.collapsed ? 'hidden' : '';
        const arrow = section.collapsed ? '▸' : '▾';
        const escapedGroupId = escapeHtmlText(section.id);
        const escapedGroupLabel = escapeHtmlText(section.label);
        const sectionClass = extraClass ? 'group' + extraClass : 'group';
        return [
          '<section class="' + sectionClass + '" data-group-id="' + escapedGroupId + '">',
          '<div class="group-header">',
          '<button class="toggle" type="button" data-group-toggle="' + escapedGroupId + '">' + arrow + '</button>',
          '<input class="group-checkbox" type="checkbox" data-group-id="' + escapedGroupId + '" ' + groupChecked + ' ' + groupDisabled + ' data-group-state="' + groupState + '" />',
          '<span class="group-title">' + escapedGroupLabel + '</span>',
          '<span class="group-count">' + matchedItems.length + '/' + section.items.length + '</span>',
          '</div>',
          '<div class="tools ' + collapsedClass + '" data-group-tools="' + escapedGroupId + '">',
          toolRows,
          '</div>',
          '</section>',
        ].join('');
      }

      function render() {
        if (!tree) {
          return;
        }
        const keyword = lower(state.search.trim());
        const visibleSectionViews = [];
        for (const section of state.sections) {
          const matchedItems = section.items.filter((item) => isToolMatched(item, keyword));
          if (matchedItems.length === 0) {
            continue;
          }
          visibleSectionViews.push({
            section,
            matchedItems,
            groupState: computeGroupState(section.items),
          });
        }

        if (visibleSectionViews.length === 0) {
          tree.innerHTML = '<div class="empty">No tools match the current filter.</div>';
          updateCountLabel();
          return;
        }

        const rootBlocks = [];
        const parentOrder = [];
        const parentBuckets = {};
        for (const sectionView of visibleSectionViews) {
          const parentId = typeof sectionView.section.parentId === 'string'
            ? sectionView.section.parentId
            : '';
          if (!parentId) {
            rootBlocks.push(sectionView);
            continue;
          }
          if (!parentBuckets[parentId]) {
            parentBuckets[parentId] = {
              label: sectionView.section.parentLabel || 'Grouped',
              children: [],
            };
            parentOrder.push(parentId);
            if (!(parentId in state.parentCollapsed)) {
              state.parentCollapsed[parentId] = false;
            }
          }
          parentBuckets[parentId].children.push(sectionView);
        }

        const fragments = [];
        for (const sectionView of rootBlocks) {
          fragments.push('<div class="tree-block">' + buildSectionMarkup(sectionView, '') + '</div>');
        }
        for (const parentId of parentOrder) {
          const parent = parentBuckets[parentId];
          const collapsed = state.parentCollapsed[parentId] === true;
          const arrow = collapsed ? '▸' : '▾';
          const escapedParentId = escapeHtmlText(parentId);
          const escapedParentLabel = escapeHtmlText(parent.label);
          const childMarkup = parent.children
            .map((sectionView) => buildSectionMarkup(sectionView, ' nested-group'))
            .join('');
          let matchedCount = 0;
          let totalCount = 0;
          for (const child of parent.children) {
            matchedCount += child.matchedItems.length;
            totalCount += child.section.items.length;
          }
          fragments.push([
            '<section class="tree-block" data-parent-id="' + escapedParentId + '">',
            '<div class="group-parent-header">',
            '<button class="toggle" type="button" data-parent-toggle="' + escapedParentId + '">' + arrow + '</button>',
            '<span class="group-title">' + escapedParentLabel + '</span>',
            '<span class="group-count">' + matchedCount + '/' + totalCount + '</span>',
            '</div>',
            '<div class="group-parent-children ' + (collapsed ? 'hidden' : '') + '" data-parent-children="' + escapedParentId + '">',
            childMarkup,
            '</div>',
            '</section>',
          ].join(''));
        }

        tree.innerHTML = fragments.join('');
        for (const checkbox of tree.querySelectorAll('.group-checkbox')) {
          const groupState = checkbox.getAttribute('data-group-state');
          checkbox.indeterminate = groupState === 'partial';
        }
        updateCountLabel();
      }

      function setGroupSelection(groupId, selected) {
        const section = state.sections.find((item) => item.id === groupId);
        if (!section) {
          return;
        }
        for (const tool of section.items) {
          if (tool.readOnly) {
            continue;
          }
          tool.selected = selected;
        }
      }

      function setToolSelection(toolName, selected) {
        for (const section of state.sections) {
          for (const tool of section.items) {
            if (tool.name === toolName) {
              if (tool.readOnly) {
                return;
              }
              tool.selected = selected;
              return;
            }
          }
        }
      }

      function toggleGroupCollapsed(groupId) {
        const section = state.sections.find((item) => item.id === groupId);
        if (!section) {
          return;
        }
        section.collapsed = !section.collapsed;
      }

      function toggleParentCollapsed(parentId) {
        if (!(parentId in state.parentCollapsed)) {
          state.parentCollapsed[parentId] = false;
        }
        state.parentCollapsed[parentId] = !state.parentCollapsed[parentId];
      }

      function getSelectedNames() {
        const names = [];
        for (const item of getAllItems()) {
          if (item.selected) {
            names.push(item.name);
          }
        }
        return names;
      }

      tree.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        if (target.classList.contains('group-checkbox')) {
          const groupId = target.getAttribute('data-group-id');
          if (!groupId) {
            return;
          }
          setGroupSelection(groupId, target.checked);
          render();
          return;
        }
        if (target.classList.contains('tool-checkbox')) {
          const toolName = target.getAttribute('data-tool-name');
          if (!toolName) {
            return;
          }
          setToolSelection(toolName, target.checked);
          render();
        }
      });

      tree.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const parentToggleButton = target.closest('[data-parent-toggle]');
        if (parentToggleButton) {
          const parentId = parentToggleButton.getAttribute('data-parent-toggle');
          if (!parentId) {
            return;
          }
          toggleParentCollapsed(parentId);
          render();
          return;
        }
        const toggleButton = target.closest('[data-group-toggle]');
        if (!toggleButton) {
          return;
        }
        const groupId = toggleButton.getAttribute('data-group-toggle');
        if (!groupId) {
          return;
        }
        toggleGroupCollapsed(groupId);
        render();
      });

      searchInput.addEventListener('input', () => {
        state.search = searchInput.value || '';
        render();
      });

      resetBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'reset' });
      });

      cancelBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'cancel' });
      });

      confirmBtn.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'apply', selected: getSelectedNames() });
      });

      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          vscodeApi.postMessage({ type: 'cancel' });
        }
      });

      render();
    })();
  </script>
</body>
</html>`;
}

export async function showToolConfigPanel(options: ShowToolConfigPanelOptions): Promise<ToolConfigPanelResult> {
  const panel = vscode.window.createWebviewPanel(
    'lmToolsBridge.toolConfigPanel',
    options.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    },
  );
  panel.webview.html = buildWebviewHtml(toWebviewPayload(options));

  return await new Promise<ToolConfigPanelResult>((resolve) => {
    let resolved = false;
    const finish = (result: ToolConfigPanelResult) => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(result);
      panel.dispose();
    };

    const messageDisposable = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const payload = message as { type?: unknown; selected?: unknown };
      if (payload.type === 'reset') {
        finish({ action: 'reset' });
        return;
      }
      if (payload.type === 'cancel') {
        finish({ action: 'cancel' });
        return;
      }
      if (payload.type === 'apply') {
        const selected = Array.isArray(payload.selected)
          ? payload.selected.filter((name): name is string => typeof name === 'string')
          : [];
        finish({ action: 'apply', selected });
      }
    });

    const disposeDisposable = panel.onDidDispose(() => {
      messageDisposable.dispose();
      disposeDisposable.dispose();
      if (!resolved) {
        resolve({ action: 'cancel' });
      }
    });
  });
}
