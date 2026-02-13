import type { ManagerStatusPayload } from './manager';

function formatRootsPolicySummary(policy: ManagerStatusPayload['rootsPolicy']): string {
  return `${policy.mode}, init=${String(policy.triggerOnInitialized)}, listChanged=${String(policy.triggerOnListChanged)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderStatusHtml(payload: ManagerStatusPayload): string {
  const initialPayloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const noScriptSummary = [
    `Version: ${payload.version}`,
    `Now (local): ${payload.nowLocal}`,
    `Active instances: ${payload.instances}`,
    `Active sessions: ${payload.sessions}`,
    `Roots policy: ${formatRootsPolicySummary(payload.rootsPolicy)}`,
    `Manager uptime (s): ${payload.uptimeSec}`,
    `Idle marker age (s): ${payload.lastNonEmptyAgeSec}`,
  ]
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LM Tools Bridge Manager Status</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f5f7fb;
        --fg: #111827;
        --card-bg: #ffffff;
        --card-border: #e5e7eb;
        --table-header-bg: #f3f4f6;
        --row-border: #e5e7eb;
        --muted: #6b7280;
        --danger: #b91c1c;
        --button-bg: #ffffff;
        --button-border: #d1d5db;
        --button-fg: #111827;
        --label-fg: #374151;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: var(--bg);
        color: var(--fg);
      }
      main {
        max-width: min(96vw, 1680px);
        margin: 16px auto;
        padding: 0 14px 24px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
      }
      h2 {
        margin: 0 0 8px;
        font-size: 16px;
      }
      .toolbar {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      button {
        border: 1px solid var(--button-border);
        border-radius: 6px;
        padding: 6px 10px;
        background: var(--button-bg);
        color: var(--button-fg);
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .toolbar label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .muted {
        color: var(--muted);
        font-size: 13px;
      }
      .error {
        margin: 0 0 12px;
        color: var(--danger);
        font-size: 13px;
      }
      .card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .responsive-table {
        table-layout: auto;
      }
      th, td {
        border-bottom: 1px solid var(--row-border);
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: var(--table-header-bg);
        font-weight: 600;
      }
      .kv-key {
        width: 220px;
        color: var(--label-fg);
      }
      .long-cell {
        max-width: 420px;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
      .mono-cell {
        font-family: Consolas, "Courier New", monospace;
        white-space: pre-wrap;
      }
      noscript pre {
        margin: 0;
        white-space: pre-wrap;
      }
      @media (max-width: 1365px) {
        main {
          max-width: min(98vw, 1440px);
        }
        th, td {
          padding: 7px 8px;
          font-size: 12px;
        }
        .long-cell {
          max-width: 320px;
        }
      }
      @media (max-width: 959px) {
        .table-wrap {
          overflow: visible;
        }
        .responsive-table thead {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          border: 0;
        }
        .responsive-table,
        .responsive-table tbody,
        .responsive-table tr,
        .responsive-table td {
          display: block;
          width: 100%;
          box-sizing: border-box;
        }
        .responsive-table tr {
          background: var(--card-bg);
          border: 1px solid var(--card-border);
          border-radius: 8px;
          margin: 0 0 10px;
          overflow: hidden;
        }
        .responsive-table td {
          border-bottom: 1px dashed var(--row-border);
          padding: 7px 10px;
        }
        .responsive-table td:last-child {
          border-bottom: 0;
        }
        .responsive-table td::before {
          content: attr(data-label);
          display: block;
          margin-bottom: 4px;
          color: var(--label-fg);
          font-weight: 600;
        }
        .long-cell,
        .mono-cell {
          max-width: none;
        }
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111827;
          --fg: #f3f4f6;
          --card-bg: #0f172a;
          --card-border: #334155;
          --table-header-bg: #1e293b;
          --row-border: #334155;
          --muted: #94a3b8;
          --button-bg: #1f2937;
          --button-border: #475569;
          --button-fg: #f3f4f6;
          --label-fg: #cbd5e1;
          --danger: #fca5a5;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>LM Tools Bridge Manager Status</h1>
      <div class="toolbar">
        <button id="refresh-button" type="button">Refresh</button>
        <label><input id="auto-refresh" type="checkbox" checked /> Auto refresh (6s)</label>
        <span id="updated-at" class="muted"></span>
      </div>
      <p id="error" class="error" hidden></p>

      <section class="card">
        <h2>Summary</h2>
        <div class="table-wrap">
          <table>
            <tbody id="summary-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h2>Instances</h2>
        <p id="instances-empty" class="muted">No active instances.</p>
        <div class="table-wrap">
          <table id="instances-table" class="responsive-table" hidden>
            <thead>
              <tr>
                <th>VS Code Instance Session ID</th>
                <th>PID</th>
                <th>Host:Port</th>
                <th>Workspace</th>
                <th>Last Seen (s)</th>
                <th>Uptime (s)</th>
              </tr>
            </thead>
            <tbody id="instances-body"></tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <h2>Sessions</h2>
        <p id="sessions-empty" class="muted">No active sessions.</p>
        <div class="table-wrap">
          <table id="sessions-table" class="responsive-table" hidden>
            <thead>
              <tr>
                <th>MCP Session ID</th>
                <th>Resolve CWD</th>
                <th>Workspace Flags</th>
                <th>Target</th>
                <th>Last Seen (s)</th>
                <th>Offline Since</th>
                <th>Roots</th>
                <th>Capability Flags</th>
                <th>Client Capabilities</th>
              </tr>
            </thead>
            <tbody id="sessions-body"></tbody>
          </table>
        </div>
      </section>

      <noscript>
        <section class="card">
          <h2>Summary (JavaScript disabled)</h2>
          <p class="muted">Enable JavaScript to use Refresh and Auto refresh.</p>
          <ul>${noScriptSummary}</ul>
        </section>
      </noscript>
    </main>
    <script>
      (() => {
        const STATUS_JSON_URL = '/mcp/status?format=json';
        const AUTO_REFRESH_INTERVAL_MS = 6000;
        const refreshButton = document.getElementById('refresh-button');
        const autoRefreshCheckbox = document.getElementById('auto-refresh');
        const updatedAt = document.getElementById('updated-at');
        const errorBox = document.getElementById('error');
        const summaryBody = document.getElementById('summary-body');
        const instancesTable = document.getElementById('instances-table');
        const instancesBody = document.getElementById('instances-body');
        const instancesEmpty = document.getElementById('instances-empty');
        const sessionsTable = document.getElementById('sessions-table');
        const sessionsBody = document.getElementById('sessions-body');
        const sessionsEmpty = document.getElementById('sessions-empty');
        const initialPayload = JSON.parse(atob('${initialPayloadBase64}'));
        let autoRefreshTimer;
        let refreshInFlight = false;

        function toText(value) {
          if (value === null || value === undefined || value === '') {
            return '-';
          }
          return String(value);
        }

        function appendCell(row, text, options) {
          const cellOptions = options && typeof options === 'object' ? options : {};
          const cell = document.createElement('td');
          const valueText = toText(text);
          if (cellOptions.className) {
            cell.className = cellOptions.className;
          }
          if (cellOptions.label) {
            cell.setAttribute('data-label', cellOptions.label);
          }
          cell.textContent = valueText;
          row.appendChild(cell);
        }

        function renderSummary(payload) {
          summaryBody.replaceChildren();
          const rootsPolicy = payload && payload.rootsPolicy ? payload.rootsPolicy : undefined;
          const rootsPolicyText = rootsPolicy
            ? toText(rootsPolicy.mode)
              + ', init=' + toText(rootsPolicy.triggerOnInitialized)
              + ', listChanged=' + toText(rootsPolicy.triggerOnListChanged)
            : '-';
          const rows = [
            ['Version', toText(payload.version)],
            ['Now (local)', toText(payload.nowLocal)],
            ['Active instances', toText(payload.instances)],
            ['Active sessions', toText(payload.sessions)],
            ['Roots policy', rootsPolicyText],
            ['Manager uptime (s)', toText(payload.uptimeSec)],
            ['Idle marker age (s)', toText(payload.lastNonEmptyAgeSec)],
          ];
          for (const [key, value] of rows) {
            const row = document.createElement('tr');
            appendCell(row, key, { className: 'kv-key' });
            appendCell(row, value, {});
            summaryBody.appendChild(row);
          }
        }

        function formatWorkspace(detail) {
          const folders = Array.isArray(detail.workspaceFolders) ? detail.workspaceFolders : [];
          const parts = [];
          if (folders.length > 0) {
            parts.push(folders.join(', '));
          }
          if (detail.workspaceFile) {
            parts.push('file: ' + detail.workspaceFile);
          }
          if (parts.length === 0) {
            return '-';
          }
          return parts.join(' | ');
        }

        function formatSessionTarget(detail) {
          if (!detail || !detail.target) {
            return '-';
          }
          return 'vscodeInstanceSessionId=' + detail.target.sessionId + ' @ ' + detail.target.host + ':' + detail.target.port;
        }

        function formatSessionRoots(detail) {
          const parts = [];
          parts.push('clientRootsSupported=' + toText(detail.clientRootsSupported));
          parts.push('clientRootsListChangedSupported=' + toText(detail.clientRootsListChangedSupported));
          if (detail.pendingRootsRequestId) {
            parts.push('pending=' + toText(detail.pendingRootsRequestId));
          }
          if (detail.lastRootsSyncReason) {
            parts.push('reason=' + toText(detail.lastRootsSyncReason));
          }
          if (detail.lastRootsCount !== null && detail.lastRootsCount !== undefined) {
            parts.push('count=' + toText(detail.lastRootsCount));
          }
          if (detail.lastRootsSyncAtLocal) {
            parts.push('at=' + toText(detail.lastRootsSyncAtLocal));
          }
          const preview = Array.isArray(detail.lastRootsPreview) ? detail.lastRootsPreview : [];
          if (preview.length > 0) {
            parts.push('preview=' + preview.join(' | '));
          }
          if (detail.lastRootsError) {
            parts.push('error=' + toText(detail.lastRootsError));
          }
          return parts.join(', ');
        }

        function formatSessionCapabilityFlags(detail) {
          const parts = [];
          const flags = detail
            && detail.clientCapabilityFlags
            && typeof detail.clientCapabilityFlags === 'object'
            && !Array.isArray(detail.clientCapabilityFlags)
            ? detail.clientCapabilityFlags
            : {};
          const flagKeys = Object.keys(flags).sort();
          for (const key of flagKeys) {
            parts.push(key + '=' + toText(flags[key]));
          }
          const objectKeysMap = detail
            && detail.clientCapabilityObjectKeys
            && typeof detail.clientCapabilityObjectKeys === 'object'
            && !Array.isArray(detail.clientCapabilityObjectKeys)
            ? detail.clientCapabilityObjectKeys
            : {};
          const capabilityKeys = Object.keys(objectKeysMap).sort();
          for (const key of capabilityKeys) {
            const keys = Array.isArray(objectKeysMap[key]) ? objectKeysMap[key] : [];
            if (keys.length > 0) {
              parts.push(key + '.keys=' + keys.join('|'));
            }
          }
          return parts.length > 0 ? parts.join(', ') : '-';
        }

        function formatSessionCapabilities(detail) {
          const capabilities = detail
            && detail.clientCapabilities
            && typeof detail.clientCapabilities === 'object'
            && !Array.isArray(detail.clientCapabilities)
            ? detail.clientCapabilities
            : {};
          try {
            return JSON.stringify(capabilities, null, 2);
          } catch {
            return '{}';
          }
        }

        function renderInstances(payload) {
          instancesBody.replaceChildren();
          const details = Array.isArray(payload.instanceDetails) ? payload.instanceDetails : [];
          if (details.length === 0) {
            instancesTable.hidden = true;
            instancesEmpty.hidden = false;
            return;
          }
          instancesEmpty.hidden = true;
          instancesTable.hidden = false;
          for (const detail of details) {
            const row = document.createElement('tr');
            appendCell(row, toText(detail.sessionId), {
              label: 'VS Code Instance Session ID',
              className: 'long-cell',
            });
            appendCell(row, toText(detail.pid), { label: 'PID' });
            appendCell(row, toText(detail.host) + ':' + toText(detail.port), { label: 'Host:Port' });
            appendCell(row, formatWorkspace(detail), {
              label: 'Workspace',
              className: 'long-cell',
            });
            appendCell(row, toText(detail.lastSeenAgeSec), { label: 'Last Seen (s)' });
            appendCell(row, toText(detail.uptimeSec), { label: 'Uptime (s)' });
            instancesBody.appendChild(row);
          }
        }

        function renderSessions(payload) {
          sessionsBody.replaceChildren();
          const details = Array.isArray(payload.sessionDetails) ? payload.sessionDetails : [];
          if (details.length === 0) {
            sessionsTable.hidden = true;
            sessionsEmpty.hidden = false;
            return;
          }
          sessionsEmpty.hidden = true;
          sessionsTable.hidden = false;
          for (const detail of details) {
            const row = document.createElement('tr');
            appendCell(row, toText(detail.sessionId), {
              label: 'MCP Session ID',
              className: 'long-cell',
            });
            appendCell(row, toText(detail.resolveCwd), {
              label: 'Resolve CWD',
              className: 'long-cell',
            });
            appendCell(row, 'set=' + toText(detail.workspaceSetExplicitly) + ', matched=' + toText(detail.workspaceMatched), {
              label: 'Workspace Flags',
            });
            appendCell(row, formatSessionTarget(detail), {
              label: 'Target',
              className: 'long-cell',
            });
            appendCell(row, toText(detail.lastSeenAgeSec), { label: 'Last Seen (s)' });
            appendCell(row, detail.offlineSinceLocal ? detail.offlineSinceLocal : '-', { label: 'Offline Since' });
            appendCell(row, formatSessionRoots(detail), {
              label: 'Roots',
              className: 'long-cell',
            });
            appendCell(row, formatSessionCapabilityFlags(detail), {
              label: 'Capability Flags',
              className: 'long-cell',
            });
            appendCell(row, formatSessionCapabilities(detail), {
              label: 'Client Capabilities',
              className: 'long-cell mono-cell',
            });
            sessionsBody.appendChild(row);
          }
        }

        function renderPayload(payload) {
          renderSummary(payload);
          renderInstances(payload);
          renderSessions(payload);
          updatedAt.textContent = 'Last updated: ' + toText(payload.nowLocal);
        }

        async function refreshStatus(showError) {
          if (refreshInFlight) {
            return;
          }
          refreshInFlight = true;
          refreshButton.disabled = true;
          try {
            const response = await fetch(STATUS_JSON_URL, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              cache: 'no-store',
            });
            if (!response.ok) {
              throw new Error('HTTP ' + response.status);
            }
            const payload = await response.json();
            renderPayload(payload);
            errorBox.hidden = true;
            errorBox.textContent = '';
          } catch (error) {
            if (showError) {
              errorBox.hidden = false;
              errorBox.textContent = 'Failed to refresh status: ' + (error instanceof Error ? error.message : String(error));
            }
          } finally {
            refreshButton.disabled = false;
            refreshInFlight = false;
          }
        }

        function setAutoRefresh(enabled) {
          if (autoRefreshTimer !== undefined) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = undefined;
          }
          if (enabled) {
            autoRefreshTimer = setInterval(() => {
              void refreshStatus(false);
            }, AUTO_REFRESH_INTERVAL_MS);
          }
        }

        refreshButton.addEventListener('click', () => {
          void refreshStatus(true);
        });
        autoRefreshCheckbox.addEventListener('change', () => {
          setAutoRefresh(autoRefreshCheckbox.checked);
        });

        renderPayload(initialPayload);
        autoRefreshCheckbox.checked = true;
        setAutoRefresh(true);
      })();
    </script>
  </body>
</html>`;
}
