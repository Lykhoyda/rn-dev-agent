import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const REFS_DIR = resolve(ROOT, 'skills/rn-best-practices/references');
const OUT_DIR = resolve(__dirname, '../src/content/docs/best-practices/rules');

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(REFS_DIR).filter(f => f.endsWith('.md')).sort();
let count = 0;

for (const file of files) {
  const content = readFileSync(resolve(REFS_DIR, file), 'utf8');
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

  const mdx = `---
title: "${title.replace(/"/g, '\\"')}"
description: "${impact} impact — ${tags}"
---
${body}`;

  writeFileSync(resolve(OUT_DIR, `${slug}.mdx`), mdx);
  count++;
}

console.log(`Generated ${count} best-practice rule pages.`);
