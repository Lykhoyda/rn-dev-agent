import assert from 'node:assert/strict';
import { parse } from 'yaml';

export function skillFrontmatter(markdown: string): Record<string, unknown> {
  const lines = markdown.split(/\r?\n/);
  assert.equal(lines[0], '---', 'skill must start with YAML frontmatter');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'skill must close YAML frontmatter');
  const metadata: unknown = parse(lines.slice(1, end).join('\n'));
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
  return metadata as Record<string, unknown>;
}
