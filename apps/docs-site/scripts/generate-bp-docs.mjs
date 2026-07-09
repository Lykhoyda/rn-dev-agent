import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const REFS_DIR = resolve(
  ROOT,
  'packages/shared-agent-knowledge/skills/rn-best-practices/references',
);
const OUT_DIR = resolve(__dirname, '../src/content/docs/best-practices/rules');

mkdirSync(OUT_DIR, { recursive: true });

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    })
    .sort();
}

const files = markdownFiles(REFS_DIR);
let count = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const slug = basename(file, '.md');

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let title, impact, tags, body;

  if (fmMatch) {
    const frontmatter = fmMatch[1];
    body = fmMatch[2];
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    const impactMatch = frontmatter.match(/^impact:\s*(.+)$/m);
    const tagsMatch = frontmatter.match(/^tags:\s*(.+)$/m);
    title = titleMatch ? titleMatch[1].trim() : slug;
    impact = impactMatch ? impactMatch[1].trim() : 'MEDIUM';
    tags = tagsMatch ? tagsMatch[1].trim() : '';
  } else {
    body = content;
    const h1Match = content.match(/^#\s+(.+)$/m);
    title = h1Match ? h1Match[1].trim() : slug.replace(/-/g, ' ');
    const impactLine = content.match(/\*\*Impact:\s*(\w+)/i);
    impact = impactLine ? impactLine[1].toUpperCase() : 'MEDIUM';
    tags = '';
  }

  // CodeQL js/incomplete-sanitization (alert #14): escape backslashes BEFORE
  // double-quotes so we don't double-escape a pre-existing `\"` into `\\"`.
  const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const mdx = `---
title: "${escapedTitle}"
description: "${impact} impact — ${tags}"
---
${body}`;

  writeFileSync(resolve(OUT_DIR, `${slug}.mdx`), mdx);
  count++;
}

console.log(`Generated ${count} best-practice rule pages.`);
