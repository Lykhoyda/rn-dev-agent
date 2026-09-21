import { createHash } from 'node:crypto';

export interface Target {
  quoted?: string;
  phrase: string;
}

export type Step =
  | { kind: 'press'; target: Target }
  | { kind: 'fill'; target: Target; text: string }
  | { kind: 'scroll'; direction: 'down' | 'up'; until?: Target }
  | { kind: 'wait'; target: Target }
  | { kind: 'back' }
  | { kind: 'dialog'; action: 'accept' | 'dismiss' };

export interface Check {
  kind: 'check';
  text: string;
  literal: boolean;
}

export type Item = (Step | Check) & { line: number; raw: string; source: 'grammar' | 'jev' };

export interface Block {
  slug: string;
  title: string;
  startsOn?: string;
  items: Item[];
  planHash: string;
}

export interface RefusedLine {
  line: number;
  text: string;
  reason: string;
}

export type ParsedPlan =
  | { blocks: Block[]; refused?: undefined }
  | { blocks?: undefined; refused: RefusedLine[] };

const QUOTED = /"([^"]+)"|“([^”]+)”/;

export function firstQuoted(text: string): string | undefined {
  const match = QUOTED.exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
}

export function targetFrom(text: string): Target {
  return {
    quoted: firstQuoted(text),
    phrase: text
      .replace(/["“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

const BACK = /^(?:go|navigate|press|tap)?\s*back(?:\s+(?:button|arrow))?$/i;
const DIALOG =
  /^(accept|allow|dismiss|deny|decline|cancel)\b.*\b(?:dialog|prompt|alert|permissions?)\b/i;
const SCROLL =
  /^scroll(?:\s+(down|up))?(?:\s+(?:until|till|to)\b\s*(?:you\s+(?:see|reach|find)\s+|(?:see|reach|find)\s+)?(.+))?$/i;
const WAIT =
  /^wait\s+(?:for|until)\s+(.+?)(?:\s+(?:to\s+)?(?:appears?|is\s+visible|shows?(?:\s+up)?))?$/i;
const FILL = /^(?:type|enter|input|write|fill(?:\s+in)?)\b\s*(.*)$/i;
const FILL_WITH = /^(.*?)\s+with\s+("[^"]+"|“[^”]+”)\s*$/i;
const PRESS =
  /^(?:tap|press|click|open|select|choose|toggle|hit|go\s+to)\b\s*(?:on\s+)?(?:the\s+)?(.+)$/i;

type Grammar = Step | { refuse: string } | null;

function parseFill(rest: string): Grammar {
  const withForm = FILL_WITH.exec(rest);
  if (withForm) {
    const text = firstQuoted(withForm[2]);
    if (text === undefined || !withForm[1].trim())
      return { refuse: 'fill needs a target and the text in quotes' };
    return { kind: 'fill', target: targetFrom(withForm[1]), text };
  }
  const match = QUOTED.exec(rest);
  if (!match) return { refuse: 'fill needs the text in quotes' };
  const text = match[1] ?? match[2];
  const after = rest
    .slice(match.index + match[0].length)
    .replace(/^\s*(?:(?:into|in|to|on|inside)\s+)?(?:the\s+)?/i, '')
    .trim();
  if (!after) return { refuse: 'fill needs a target after the quoted text' };
  return { kind: 'fill', target: targetFrom(after), text };
}

export function parseStep(rest: string): Grammar {
  if (BACK.test(rest)) return { kind: 'back' };
  const dialog = DIALOG.exec(rest);
  if (dialog) {
    const verb = dialog[1].toLowerCase();
    return { kind: 'dialog', action: verb === 'accept' || verb === 'allow' ? 'accept' : 'dismiss' };
  }
  const scroll = SCROLL.exec(rest);
  if (scroll) {
    const direction = (scroll[1] ?? 'down').toLowerCase() as 'down' | 'up';
    return scroll[2]
      ? { kind: 'scroll', direction, until: targetFrom(scroll[2]) }
      : { kind: 'scroll', direction };
  }
  const wait = WAIT.exec(rest);
  if (wait) return { kind: 'wait', target: targetFrom(wait[1]) };
  const fill = FILL.exec(rest);
  if (fill) return parseFill(fill[1]);
  const press = PRESS.exec(rest);
  if (press) return { kind: 'press', target: targetFrom(press[1]) };
  return null;
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plan'
  );
}

export function planHash(items: Item[]): string {
  const normalized = items.map((item) => item.raw.replace(/\s+/g, ' ').trim()).join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

const CHECK = /^(?:[-*]\s*)?[✓✔]\s*(.+)$/;
const NUMBERED = /^(\d+)[.)]\s+(.+)$/;
const HEADING = /^###\s+(.+)$/;
const STARTS_ON = /^starts?\s+on:\s*(.+)$/i;

// Returns the visible part of a line with every `<!-- -->` span removed, carrying an
// open comment across lines.
function uncomment(raw: string, comment: { open: boolean }): string {
  let rest = raw;
  let out = '';
  while (rest.length > 0) {
    if (comment.open) {
      const close = rest.indexOf('-->');
      if (close < 0) break;
      comment.open = false;
      rest = rest.slice(close + 3);
      continue;
    }
    const open = rest.indexOf('<!--');
    if (open < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, open);
    comment.open = true;
    rest = rest.slice(open + 4);
  }
  return out.trim();
}

// Comments are stripped once for the whole document, one entry per source line, so every
// scan below sees the same visible text and line numbers stay those of the file.
function visibleLines(lines: string[]): string[] {
  const comment = { open: false };
  return lines.map((line) => uncomment(line, comment));
}

const isSectionHeading = (text: string): boolean => /^##\s+/.test(text) && !text.startsWith('###');

// Splits `## QA` (or the whole text) into blocks by `###` heading and reads every
// numbered or ✓ line by the verb grammar. Lines the grammar cannot read are refused with their number.
export function parsePlan(markdown: string): ParsedPlan {
  const visible = visibleLines(markdown.split(/\r?\n/));
  let start = 0;
  let end = visible.length;
  const qa = visible.findIndex((text) => /^##\s+QA\s*$/i.test(text));
  if (qa >= 0) {
    start = qa + 1;
    const next = visible.findIndex((text, i) => i >= start && isSectionHeading(text));
    end = next >= 0 ? next : visible.length;
  }
  const titleLine = visible.find((text) => /^#\s+/.test(text));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : 'plan';

  const blocks: Block[] = [];
  const refused: RefusedLine[] = [];
  let current: Block | null = null;
  let declaredAt: number | null = null;
  const open = (heading: string): Block => {
    current = { slug: slugify(heading), title: heading, items: [], planHash: '' };
    blocks.push(current);
    return current;
  };
  const closeDeclared = (): void => {
    if (current && declaredAt !== null && current.items.length === 0) {
      refused.push({
        line: declaredAt,
        text: `### ${current.title}`,
        reason:
          'this block has no steps (reusing a saved block by heading arrives with blocks in a later phase)',
      });
    }
  };
  for (let i = start; i < end; i += 1) {
    const line = i + 1;
    const text = visible[i];
    if (!text) continue;
    const heading = HEADING.exec(text);
    if (heading) {
      closeDeclared();
      const title = heading[1].trim();
      if (blocks.some((b) => b.slug === slugify(title))) {
        refused.push({ line, text, reason: `another block is already named "${slugify(title)}"` });
      }
      open(title);
      declaredAt = line;
      continue;
    }
    if (text.startsWith('#')) continue;
    const startsOn = STARTS_ON.exec(text);
    if (startsOn) {
      (current ?? open(title)).startsOn = startsOn[1].trim();
      continue;
    }
    const check = CHECK.exec(text);
    const numbered = NUMBERED.exec(text);
    if (!check && !numbered) {
      refused.push({ line, text, reason: 'not a numbered step or a ✓ line' });
      continue;
    }
    const block = current ?? open(title);
    if (check) {
      const quoted = firstQuoted(check[1]);
      block.items.push({
        kind: 'check',
        text: quoted ?? check[1].trim(),
        literal: quoted !== undefined,
        line,
        raw: text,
        source: 'grammar',
      });
      continue;
    }
    const step = parseStep(numbered![2].trim());
    if (step === null) {
      refused.push({
        line,
        text,
        reason:
          'no verb the grammar knows (tap, type, scroll, wait, back, accept or dismiss the dialog)',
      });
    } else if ('refuse' in step) {
      refused.push({ line, text, reason: step.refuse });
    } else {
      block.items.push({ ...step, line, raw: text, source: 'grammar' });
    }
  }
  closeDeclared();
  if (refused.length > 0) return { refused };
  const filled = blocks.filter((b) => b.items.length > 0);
  if (filled.length === 0)
    return { refused: [{ line: 0, text: '', reason: 'the plan has no steps' }] };
  for (const block of filled) block.planHash = planHash(block.items);
  return { blocks: filled };
}
