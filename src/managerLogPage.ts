import * as http from 'node:http';

function escapeLogLine(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export function handleManagerLogRequest(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestUrl: URL;
  getLogLines: () => string[];
  respondJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
}): boolean {
  const {
    req,
    res,
    requestUrl,
    getLogLines,
    respondJson,
  } = args;
  if ((requestUrl.pathname !== '/mcp/log' && requestUrl.pathname !== '/mcp/log/') || req.method !== 'GET') {
    return false;
  }
  const logLines = getLogLines();
  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(',') : req.headers.accept ?? '';
  if (accept.includes('text/html')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>LM Tools Bridge Manager Log</title>
    <style>
      body { font-family: Consolas, "Courier New", monospace; margin: 16px; }
      h1 { font-size: 16px; margin: 0 0 12px 0; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>LM Tools Bridge Manager Log</h1>
    <pre>${logLines.map((line) => escapeLogLine(line)).join('\n')}</pre>
  </body>
</html>`);
    return true;
  }
  respondJson(res, 200, { ok: true, lines: logLines });
  return true;
}
