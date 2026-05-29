export const TOOL_RESULT_CARD_RESOURCE_URI = 'ui://lm-tools-bridge/tool-result-card.html';
export const TOOL_RESULT_CARD_MIME_TYPE = 'text/html+skybridge';
export const TOOL_INVOCATION_INVOKING = 'Running tool...';
export const TOOL_INVOCATION_INVOKED = 'Tool result ready';

const TOOL_TITLE_PREFIXES = [
  'lmToolsBridge_',
  'lm_',
];

const INITIALISM_TITLES = new Map<string, string>([
  ['api', 'API'],
  ['id', 'ID'],
  ['json', 'JSON'],
  ['lm', 'LM'],
  ['mcp', 'MCP'],
  ['qgrep', 'Qgrep'],
  ['ui', 'UI'],
  ['uri', 'URI'],
  ['url', 'URL'],
  ['vs', 'VS'],
  ['vscode', 'VS Code'],
]);

export function buildReadableToolTitle(name: string): string {
  let value = name.trim();
  for (const prefix of TOOL_TITLE_PREFIXES) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  const spaced = value
    .replace(/[_-]+/gu, ' ')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!spaced) {
    return name;
  }
  return spaced
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase();
      return INITIALISM_TITLES.get(lower) ?? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringRecordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function withToolDescriptorAppsMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(meta ?? {}) };
  const existingUi = isRecord(next.ui) ? next.ui : {};
  const resourceUri =
    readStringRecordValue(existingUi, 'resourceUri')
    ?? readStringRecordValue(next, 'ui/resourceUri')
    ?? readStringRecordValue(next, 'openai/outputTemplate')
    ?? TOOL_RESULT_CARD_RESOURCE_URI;

  next.ui = {
    ...existingUi,
    resourceUri,
  };
  next['ui/resourceUri'] = resourceUri;
  next['openai/outputTemplate'] = resourceUri;
  if (typeof next['openai/toolInvocation/invoking'] !== 'string') {
    next['openai/toolInvocation/invoking'] = TOOL_INVOCATION_INVOKING;
  }
  if (typeof next['openai/toolInvocation/invoked'] !== 'string') {
    next['openai/toolInvocation/invoked'] = TOOL_INVOCATION_INVOKED;
  }
  return next;
}

export function getToolResultCardResourceDefinition(): Record<string, unknown> {
  return {
    uri: TOOL_RESULT_CARD_RESOURCE_URI,
    name: 'Tool result card',
    title: 'Tool Result Card',
    description: 'Renders lm-tools-bridge tool results.',
    mimeType: TOOL_RESULT_CARD_MIME_TYPE,
  };
}

export function getToolResultCardResourceMeta(): Record<string, unknown> {
  const csp = {
    connectDomains: [],
    resourceDomains: [],
  };
  return {
    ui: {
      prefersBorder: true,
      csp,
    },
    'openai/widgetDescription': 'Displays lm-tools-bridge tool result content.',
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': {
      connect_domains: [],
      resource_domains: [],
    },
  };
}

export function getToolResultCardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tool Result</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      padding: 12px;
      background: transparent;
      color: CanvasText;
    }
    .card {
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 12px;
      background: Canvas;
    }
    .title {
      font-size: 14px;
      font-weight: 650;
      margin: 0 0 4px;
    }
    .status {
      font-size: 12px;
      color: color-mix(in srgb, CanvasText 68%, transparent);
      margin: 0 0 10px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <section class="card" aria-live="polite">
    <h1 class="title" id="title">Tool Result</h1>
    <p class="status" id="status">Tool result ready</p>
    <pre id="result">{}</pre>
  </section>
  <script>
    const bridgeMeta = window.openai?.toolResponseMetadata?.mcp_tool_result?._meta?.lmToolsBridge
      ?? window.openai?.toolResponseMetadata?.lmToolsBridge
      ?? {};
    const output = window.openai?.toolOutput ?? {};
    document.getElementById('title').textContent = bridgeMeta.title || bridgeMeta.toolName || 'Tool Result';
    document.getElementById('status').textContent = bridgeMeta.isError ? 'Tool returned an error' : 'Tool result ready';
    document.getElementById('result').textContent = JSON.stringify(output, null, 2);
  </script>
</body>
</html>`;
}

export function buildToolResultBridgeMeta(
  toolName: string,
  title: string,
  isError: boolean,
): Record<string, unknown> {
  return {
    toolName,
    title,
    isError,
  };
}
