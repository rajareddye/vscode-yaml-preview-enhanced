import { toJsonText, toResolvedYaml } from './render';
import { ParsedYaml, RenderOptions } from './types';

type View = Pick<RenderOptions, 'sortKeys' | 'maskKeys'>;

/** Every document as JSON; a single document is emitted unwrapped. */
export function exportJson(parsed: ParsedYaml, opts: View): string {
  const docs = parsed.docs.filter((d) => d.json !== undefined);
  if (docs.length === 0) {
    throw new Error(
      parsed.docs[0]?.resolveError ?? 'There is nothing to export.',
    );
  }
  if (docs.length === 1) {
    return toJsonText(docs[0].json, opts) + '\n';
  }
  return toJsonText(docs.map((d) => d.json), opts) + '\n';
}

/** Resolved YAML (anchors/merge keys expanded), documents joined by `---`. */
export function exportResolvedYaml(parsed: ParsedYaml, opts: View): string {
  const docs = parsed.docs.filter((d) => d.json !== undefined);
  if (docs.length === 0) {
    throw new Error(
      parsed.docs[0]?.resolveError ?? 'There is nothing to export.',
    );
  }
  return docs.map((d) => toResolvedYaml(d.json, opts)).join('\n---\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof Uint8Array);

const isScalar = (v: unknown): boolean => v === null || !isObj(v) && !Array.isArray(v);

function scalarText(v: unknown): string {
  if (v === null || v === undefined) {
    return '*null*';
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (v instanceof Uint8Array) {
    return `*binary, ${v.length} bytes*`;
  }
  return String(v);
}

function cell(v: unknown): string {
  if (Array.isArray(v) || isObj(v)) {
    return '`' + JSON.stringify(v).replace(/`/g, "'") + '`';
  }
  return scalarText(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function heading(level: number, text: string): string {
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text.replace(/\n/g, ' ')}`;
}

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n$/, '')}\n${f}`;
}

function isTableRows(arr: unknown[]): arr is Record<string, unknown>[] {
  if (arr.length < 2 || !arr.every(isObj)) {
    return false;
  }
  const rows = arr as Record<string, unknown>[];
  return rows.every((r) => Object.keys(r).length > 0 && Object.values(r).every((v) => isScalar(v)));
}

function renderValue(value: unknown, level: number, out: string[]): void {
  if (isObj(value)) {
    let bullets: string[] = [];
    const flush = () => {
      if (bullets.length) {
        out.push(bullets.join('\n'));
        bullets = [];
      }
    };
    for (const [k, v] of Object.entries(value)) {
      if (isScalar(v) && !(typeof v === 'string' && v.includes('\n'))) {
        bullets.push(`- **${k}**: ${scalarText(v)}`);
        continue;
      }
      flush();
      if (typeof v === 'string') {
        out.push(heading(level, k), fence(v));
        continue;
      }
      out.push(heading(level, k));
      renderValue(v, level + 1, out);
    }
    flush();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push('*(empty list)*');
    } else if (isTableRows(value)) {
      const cols: string[] = [];
      for (const r of value) {
        for (const k of Object.keys(r)) {
          if (!cols.includes(k)) {
            cols.push(k);
          }
        }
      }
      // One block: the caller joins blocks with blank lines, which would
      // otherwise split the table into separate paragraphs.
      out.push(
        [
          `| ${cols.join(' | ')} |`,
          `| ${cols.map(() => '---').join(' | ')} |`,
          ...value.map(
            (r) =>
              `| ${cols.map((c) => (c in r ? cell(r[c]) : '')).join(' | ')} |`,
          ),
        ].join('\n'),
      );
    } else if (value.every((v) => isScalar(v) && !(typeof v === 'string' && v.includes('\n')))) {
      out.push(value.map((v) => `- ${scalarText(v)}`).join('\n'));
    } else {
      value.forEach((v, i) => {
        out.push(heading(level, `Item ${i + 1}`));
        renderValue(v, level + 1, out);
      });
    }
    return;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    out.push(fence(value));
  } else {
    out.push(scalarText(value));
  }
}

/**
 * Turn a YAML file into a readable Markdown report: mappings become headings
 * and bullet lists, lists of records become tables, multi-line strings become
 * fenced blocks.
 */
export function exportMarkdown(
  parsed: ParsedYaml,
  opts: View & { title: string },
): string {
  const out: string[] = [heading(1, opts.title)];
  const multi = parsed.docs.length > 1;
  for (const doc of parsed.docs) {
    if (multi) {
      out.push(heading(2, doc.label));
    }
    if (doc.json === undefined) {
      out.push(`> ⚠️ ${doc.resolveError ?? 'This document could not be resolved.'}`);
      continue;
    }
    // Mask / sort through the same path as the other exports.
    const value = JSON.parse(toJsonText(doc.json, opts));
    renderValue(value, multi ? 3 : 2, out);
  }
  return out.join('\n\n') + '\n';
}
