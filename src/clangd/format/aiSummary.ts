export interface SummaryEntry {
  location: string;
  summary: string;
}

export interface SummaryCounts {
  total: number;
  shown: number;
  truncated: boolean;
  kind: string;
  extras?: Record<string, string | number | boolean>;
}

export function renderCountsLine(counts: SummaryCounts): string {
  const parts: string[] = [
    `counts total=${counts.total}`,
    `shown=${counts.shown}`,
    `truncated=${counts.truncated}`,
    `kind=${counts.kind}`,
  ];
  if (counts.extras) {
    for (const [key, value] of Object.entries(counts.extras)) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(' ');
}

export function renderEntries(entries: readonly SummaryEntry[]): string {
  return entries
    .map((entry) => `${entry.location}\n${entry.summary}`)
    .join('\n---\n');
}

export function renderSection(title: string, body: string): string {
  if (!body.trim()) {
    return '';
  }
  return `[${title}]\n${body}`;
}

export function renderSummaryText(
  counts: SummaryCounts,
  entries: readonly SummaryEntry[],
  sections: readonly string[] = [],
): string {
  const blocks: string[] = [renderCountsLine(counts), '---'];
  const validSections = sections.map((section) => section.trim()).filter((section) => section.length > 0);
  if (validSections.length > 0) {
    blocks.push(validSections.join('\n---\n'));
  }
  if (entries.length > 0) {
    blocks.push(renderEntries(entries));
  }
  return blocks.join('\n');
}
