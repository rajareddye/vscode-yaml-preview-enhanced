import { stringify } from 'yaml';
import { esc } from './html';
import { renderMarkdown } from './markdown';
import {
  diagramPlaceholderHtml,
  ensureStart,
  hashString,
  splitPlantUml,
} from './plantuml';
import { classifyImageRef, linkify } from './text';
import {
  Issue,
  ParsedYaml,
  RenderOptions,
  ViewName,
  YDoc,
  YNode,
} from './types';

export interface RenderMeta {
  docCount: number;
  errorCount: number;
  warningCount: number;
  schemaIssueCount: number;
  nodeCount: number;
  lineCount: number;
  docLabels: string[];
}

export interface RenderResult {
  /** Inner HTML of the main content area (one `<section class="doc">` each). */
  content: string;
  /** Inner HTML of the outline sidebar. */
  outline: string;
  meta: RenderMeta;
  /**
   * Every PlantUML diagram referenced by `content`, as placeholders carrying
   * `data-uml="<hash>"`. The host renders them and streams the results in.
   */
  diagrams: DiagramRef[];
}

export interface DiagramRef {
  hash: string;
  /** Complete `@start… @end…` source. */
  source: string;
}

interface RCtx {
  opts: RenderOptions;
  masks: RegExp[];
  doc: number;
  /** Element-id prefix, so the tree and document views never share ids. */
  idPrefix: 'n' | 'd';
  diagrams: Map<string, string>;
}

/** Hard cap so a pathological file cannot spawn thousands of JVMs. */
const MAX_DIAGRAMS = 100;

const MASK = '••••••';
const MAX_TABLE_COLUMNS = 24;

/** Build the preview HTML for every document of a parsed stream. */
export function renderPreview(
  parsed: ParsedYaml,
  options: RenderOptions,
): RenderResult {
  const masks = compileMasks(options.maskKeys);
  const sections: string[] = [];
  const diagrams = new Map<string, string>();
  let nodeCount = 0;
  let schemaIssueCount = 0;

  parsed.docs.forEach((doc, i) => {
    nodeCount += doc.nodeCount;
    schemaIssueCount += doc.schemaIssues.length;
    const base = { opts: options, masks, doc: i, diagrams };
    sections.push(
      renderDoc(
        doc,
        parsed,
        { ...base, idPrefix: 'n' },
        { ...base, idPrefix: 'd' },
      ),
    );
  });

  if (parsed.docs.length === 0) {
    sections.push(
      '<section class="doc empty-doc"><div class="empty">This file contains no YAML documents.</div></section>',
    );
  }

  return {
    content: sections.join('\n'),
    outline: renderOutline(parsed, masks, options),
    meta: {
      docCount: parsed.docs.length,
      errorCount: parsed.errorCount,
      warningCount: parsed.warningCount,
      schemaIssueCount,
      nodeCount,
      lineCount: parsed.lineCount,
      docLabels: parsed.docs.map((d) => d.label),
    },
    diagrams: [...diagrams].map(([hash, source]) => ({ hash, source })),
  };
}

/* ------------------------------------------------------------------ */
/* Masking & sorting (display-only transforms)                         */
/* ------------------------------------------------------------------ */

export function compileMasks(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try {
      out.push(new RegExp(s, 'i'));
    } catch {
      /* ignore invalid patterns */
    }
  }
  return out;
}

function isMasked(n: YNode, ctx: { masks: RegExp[] }): boolean {
  return (
    !!n.key &&
    !n.key.isMerge &&
    ctx.masks.length > 0 &&
    ctx.masks.some((r) => r.test(n.key!.text))
  );
}

function sortedChildren(n: YNode, ctx: RCtx): YNode[] {
  const kids = n.children ?? [];
  if (n.type !== 'map' || ctx.opts.sortKeys === 'none') {
    return kids;
  }
  const dir = ctx.opts.sortKeys === 'asc' ? 1 : -1;
  return kids
    .slice()
    .sort(
      (a, b) =>
        dir *
        a.key!.text.localeCompare(b.key!.text, undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
    );
}

/**
 * Apply masking and key sorting to a plain JS value (for the JSON/resolved
 * views and exports). Never mutates the input.
 */
export function transformValue(
  value: unknown,
  opts: Pick<RenderOptions, 'sortKeys' | 'maskKeys'>,
  masks: RegExp[] = compileMasks(opts.maskKeys),
  depth = 0,
): unknown {
  if (depth > 200 || value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date || value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => transformValue(v, opts, masks, depth + 1));
  }
  let entries = Object.entries(value as Record<string, unknown>);
  if (opts.sortKeys !== 'none') {
    const dir = opts.sortKeys === 'asc' ? 1 : -1;
    entries = entries.sort(
      ([a], [b]) =>
        dir * a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = masks.some((r) => r.test(k))
      ? MASK
      : transformValue(v, opts, masks, depth + 1);
  }
  return out;
}

/** JSON text of a parsed document (used by the JSON view and exports). */
export function toJsonText(
  value: unknown,
  opts: Pick<RenderOptions, 'sortKeys' | 'maskKeys'>,
): string {
  return JSON.stringify(
    transformValue(value, opts),
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}

/** Round-tripped YAML with every anchor, alias and merge key expanded. */
export function toResolvedYaml(
  value: unknown,
  opts: Pick<RenderOptions, 'sortKeys' | 'maskKeys'>,
): string {
  return stringify(transformValue(value, opts), {
    aliasDuplicateObjects: false,
    lineWidth: 0,
    indent: 2,
  }).replace(/\n$/, '');
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

function isEmptyRoot(root: YNode | null): boolean {
  return (
    root === null ||
    (root.type === 'scalar' &&
      root.scalar?.kind === 'null' &&
      root.scalar.text === '' &&
      !root.tag &&
      !root.anchor)
  );
}

function renderDoc(
  doc: YDoc,
  parsed: ParsedYaml,
  ctx: RCtx,
  docCtx: RCtx,
): string {
  const id = `doc-${doc.index}`;
  const issues: Issue[] = [...doc.errors, ...doc.warnings, ...doc.schemaIssues];
  const parts: string[] = [];

  // Header -----------------------------------------------------------
  const chips: string[] = [
    `<span class="chip stat">${doc.nodeCount} node${doc.nodeCount === 1 ? '' : 's'}</span>`,
    `<span class="chip stat">line${doc.endLine > doc.startLine ? 's' : ''} ${doc.startLine}${doc.endLine > doc.startLine ? '–' + doc.endLine : ''}</span>`,
  ];
  for (const d of doc.directives) {
    chips.push(`<span class="chip directive">${esc(d)}</span>`);
  }
  if (parsed.schema) {
    if (parsed.schema.error) {
      chips.push(
        `<span class="chip sev-warning" title="${esc(parsed.schema.error)}">schema unavailable</span>`,
      );
    } else if (doc.schemaIssues.length === 0 && doc.errors.length === 0) {
      chips.push(
        `<span class="chip sev-ok" title="${esc(parsed.schema.source)}">✓ valid against schema</span>`,
      );
    } else if (doc.schemaIssues.length > 0) {
      chips.push(
        `<span class="chip sev-error" title="${esc(parsed.schema.source)}">${doc.schemaIssues.length} schema issue${doc.schemaIssues.length === 1 ? '' : 's'}</span>`,
      );
    }
  }
  // "Document 1" says nothing for a single-document file; keep real labels.
  const showTitle =
    parsed.docs.length > 1 || !/^Document \d+$/.test(doc.label);
  parts.push(
    `<header class="doc-head">${showTitle ? `<h2 class="doc-title">${esc(doc.label)}</h2>` : ''}${chips.join('')}</header>`,
  );
  if (parsed.schema?.error) {
    parts.push(
      `<div class="notice sev-warning">Schema <code>${esc(parsed.schema.source)}</code> could not be used: ${esc(parsed.schema.error)}</div>`,
    );
  }
  if (ctx.opts.showComments && doc.commentBefore) {
    parts.push(`<pre class="doc-comment">${esc(doc.commentBefore)}</pre>`);
  }
  if (issues.length > 0) {
    parts.push(renderIssues(issues, doc.index));
  }

  // Views ------------------------------------------------------------
  const want = (v: ViewName) => !ctx.opts.views || ctx.opts.views.includes(v);
  if (want('tree')) {
    parts.push(`<div class="view view-tree">${renderTree(doc, ctx)}</div>`);
  }
  if (want('document')) {
    parts.push(
      `<div class="view view-document">${renderDocView(doc, docCtx)}</div>`,
    );
  }
  if (want('json')) {
    parts.push(
      `<div class="view view-json">${renderCodeView(doc, ctx, 'json')}</div>`,
    );
  }
  if (want('resolved')) {
    parts.push(
      `<div class="view view-resolved">${renderCodeView(doc, ctx, 'resolved')}</div>`,
    );
  }
  if (ctx.opts.showComments && doc.commentAfter) {
    parts.push(`<pre class="doc-comment">${esc(doc.commentAfter)}</pre>`);
  }

  return `<section class="doc" id="${id}" data-doc="${doc.index}" data-label="${esc(doc.label)}"${doc.index > 0 ? ' hidden' : ''}>${parts.join('')}</section>`;
}

function renderIssues(issues: Issue[], docIndex: number): string {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = issues
    .slice()
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line)
    .slice(0, 200);
  const items = sorted.map(
    (i) =>
      `<li class="issue sev-${i.severity}" data-line="${i.line}" data-col="${i.col}"${i.ptr ? ` data-ptr="${esc(i.ptr)}"` : ''}>` +
      `<span class="loc">${i.line}:${i.col}</span>` +
      `<span class="msg">${esc(i.message)}</span>` +
      `<span class="src">${i.source}${i.code ? ' · ' + esc(i.code) : ''}</span></li>`,
  );
  const more =
    issues.length > sorted.length
      ? `<li class="issue more">… and ${issues.length - sorted.length} more</li>`
      : '';
  return `<details class="issues" open data-doc="${docIndex}"><summary>${issues.length} issue${issues.length === 1 ? '' : 's'}</summary><ul>${items.join('')}${more}</ul></details>`;
}

/* ------------------------------------------------------------------ */
/* Tree view                                                           */
/* ------------------------------------------------------------------ */

function renderTree(doc: YDoc, ctx: RCtx): string {
  if (isEmptyRoot(doc.root)) {
    return '<div class="empty">Empty document</div>';
  }
  return `<ul class="tree">${renderNode(doc.root as YNode, 0, ctx)}</ul>`;
}

function nodeId(ctx: RCtx, n: YNode): string {
  return `${ctx.idPrefix}-${ctx.doc}-${n.nid}`;
}

function renderNode(n: YNode, depth: number, ctx: RCtx): string {
  const masked = isMasked(n, ctx);
  const container =
    !masked &&
    (n.type === 'map' || n.type === 'seq') &&
    !!n.children &&
    n.children.length > 0;
  const cls = [
    'node',
    `n-${n.type}`,
    n.issues?.length ? 'has-issue' : '',
    n.alias?.unresolved ? 'bad-alias' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const attrs = `id="${nodeId(ctx, n)}" data-line="${n.line}" data-end="${n.endLine}" data-ptr="${esc(n.ptr)}"`;

  if (!container) {
    const v = valueHtml(n, ctx, masked);
    return (
      `<li class="${cls}" ${attrs}><div class="row">${rowHtml(n, ctx, v.inline)}</div>` +
      (v.block ?? '') +
      '</li>'
    );
  }

  const cols = n.type === 'seq' ? tableColumns(n, ctx) : null;
  const open = depth < ctx.opts.expandDepth ? ' open' : '';
  const body = cols
    ? renderTable(n, cols, ctx)
    : `<ul class="children">${sortedChildren(n, ctx)
        .map((c) => commentBefore(c, ctx) + renderNode(c, depth + 1, ctx))
        .join('')}</ul>`;
  return (
    `<li class="${cls}${cols ? ' as-table' : ''}" ${attrs}>` +
    `<details${open}><summary class="row">${rowHtml(n, ctx, containerMeta(n, !!cols))}</summary>${body}</details></li>`
  );
}

function commentBefore(n: YNode, ctx: RCtx): string {
  if (!ctx.opts.showComments || !n.commentBefore) {
    return '';
  }
  return `<li class="cmt-line" data-line="${Math.max(1, n.line - n.commentBefore.split('\n').length)}">${esc(n.commentBefore)
    .split('\n')
    .map((l) => `<span class="cmt">#${l.startsWith(' ') ? '' : ' '}${l}</span>`)
    .join('<br>')}</li>`;
}

function containerMeta(n: YNode, asTable: boolean): string {
  const count = n.children?.length ?? 0;
  if (n.type === 'map') {
    return `<span class="glyph">{ }</span><span class="meta">${count} key${count === 1 ? '' : 's'}</span>`;
  }
  return `<span class="glyph">[ ]</span><span class="meta">${count} item${count === 1 ? '' : 's'}${asTable ? ' · table' : ''}</span>`;
}

function labelHtml(n: YNode): string {
  if (n.key) {
    const k = n.key;
    const cls = k.isMerge ? 'key merge' : `key k-${k.kind}`;
    const extra =
      (k.anchor ? `<span class="chip anchor">&amp;${esc(k.anchor)}</span>` : '') +
      (k.tag ? `<span class="chip tag">${esc(k.tag)}</span>` : '');
    return `<span class="label"><span class="${cls}">${esc(k.text)}</span>${extra}<span class="colon">:</span></span>`;
  }
  if (n.index !== undefined) {
    return `<span class="label"><span class="idx">${n.index}</span></span>`;
  }
  return '<span class="label"><span class="idx root">root</span></span>';
}

function chipsHtml(n: YNode): string {
  let out = '';
  if (n.anchor) {
    out += `<span class="chip anchor" data-anchor="${esc(n.anchor)}">&amp;${esc(n.anchor)}</span>`;
  }
  if (n.tag) {
    out += `<span class="chip tag">${esc(n.tag)}</span>`;
  }
  return out;
}

const BADGE: Record<string, string> = {
  string: 'str',
  int: 'int',
  float: 'float',
  bool: 'bool',
  null: 'null',
  timestamp: 'date',
  binary: 'bin',
  merge: 'merge',
};

function rowHtml(n: YNode, ctx: RCtx, value: string): string {
  const o = ctx.opts;
  let out = '';
  if (o.showLineNumbers) {
    out += `<span class="ln" data-line="${n.line}" title="Reveal line ${n.line} in the editor">${n.line}</span>`;
  }
  out += labelHtml(n) + chipsHtml(n) + value;
  if (o.showTypeBadges && n.scalar) {
    out += `<span class="badge">${BADGE[n.scalar.kind] ?? n.scalar.kind}</span>`;
  } else if (o.showTypeBadges && (n.type === 'map' || n.type === 'seq')) {
    out += `<span class="badge">${n.type}</span>`;
  }
  if (o.showComments && n.comment) {
    out += `<span class="cmt trailing">#${n.comment.startsWith(' ') ? '' : ' '}${esc(n.comment.replace(/\n/g, ' '))}</span>`;
  }
  if (n.issues?.length) {
    out += issueBadge(n.issues);
  }
  return out;
}

function issueBadge(issues: Issue[]): string {
  const worst = issues.some((i) => i.severity === 'error')
    ? 'error'
    : 'warning';
  const title = esc(issues.map((i) => i.message).join('\n'));
  return `<span class="issue-badge sev-${worst}" title="${title}">⚠ ${issues.length}</span>`;
}

interface ValueHtml {
  inline: string;
  block?: string;
}

function valueHtml(n: YNode, ctx: RCtx, masked: boolean): ValueHtml {
  if (masked) {
    return {
      inline: `<span class="val masked" title="Masked by yaml-preview-enhanced.maskKeys">${MASK}</span>`,
    };
  }
  if (n.type === 'alias') {
    const a = n.alias!;
    if (a.unresolved || a.targetNid === undefined) {
      return {
        inline: `<span class="chip alias bad" title="No matching anchor">*${esc(a.name)}</span>`,
      };
    }
    return {
      inline: `<a class="chip alias" href="#n-${ctx.doc}-${a.targetNid}" data-target="n-${ctx.doc}-${a.targetNid}" title="Jump to &amp;${esc(a.name)}">*${esc(a.name)}</a>`,
    };
  }
  if (n.type === 'map') {
    return { inline: '<span class="val empty">{}</span>' };
  }
  if (n.type === 'seq') {
    return { inline: '<span class="val empty">[]</span>' };
  }
  return scalarHtml(n, ctx);
}

function scalarHtml(n: YNode, ctx: RCtx): ValueHtml {
  const s = n.scalar!;
  switch (s.kind) {
    case 'null':
      return {
        inline: `<span class="val null"${s.text === '' ? ' title="empty value"' : ''}>${esc(s.text || 'null')}</span>`,
      };
    case 'bool':
    case 'int':
    case 'float':
    case 'timestamp':
    case 'binary':
    case 'merge':
      return {
        inline: `<span class="val ${s.kind}">${esc(s.text)}</span>`,
      };
    default:
      break;
  }

  if (s.multiline || (ctx.opts.plantumlEnabled && isPlantumlKey(n, ctx) && s.text.trim() !== '')) {
    const marker =
      s.style === 'literal' ? '|' : s.style === 'folded' ? '>' : '';
    const markerHtml = marker
      ? `<span class="chip blockstyle" title="${s.style} block scalar">${marker}</span>`
      : '';
    return {
      inline: markerHtml,
      block: `<div class="block">${multilineBody(n, ctx)}</div>`,
    };
  }

  const q = s.style === 'double' ? '"' : s.style === 'single' ? "'" : '';
  const text = ctx.opts.enableLinkify
    ? linkify(s.text, ctx.opts.protocols)
    : esc(s.text);
  return {
    inline: `<span class="val str">${q}${text}${q}</span>${thumbHtml(s.text, ctx)}`,
  };
}

const START_ANYWHERE = /^[ \t]*@start[a-z]+\b/im;

function isPlantumlKey(n: YNode, ctx: RCtx): boolean {
  return (
    !!n.key &&
    ctx.opts.plantumlKeys.some(
      (k) => k.toLowerCase() === n.key!.text.toLowerCase(),
    )
  );
}

/** Register a diagram and return the placeholder the host will fill in. */
function diagramPlaceholder(ctx: RCtx, source: string): string {
  const src = ensureStart(source);
  const hash = hashString(src);
  if (!ctx.diagrams.has(hash) && ctx.diagrams.size >= MAX_DIAGRAMS) {
    return `<div class="uml-note sev-warning">Diagram limit (${MAX_DIAGRAMS}) reached; further diagrams are not rendered.</div>`;
  }
  ctx.diagrams.set(hash, src);
  return diagramPlaceholderHtml(hash);
}

function preBlock(text: string, ctx: RCtx): string {
  const t = text.replace(/\n$/, '');
  const body = ctx.opts.enableLinkify ? linkify(t, ctx.opts.protocols) : esc(t);
  return `<pre class="val str ml">${body}</pre>`;
}

function multilineBody(n: YNode, ctx: RCtx): string {
  const text = n.scalar!.text;
  const uml = ctx.opts.plantumlEnabled;
  // `plantuml: |` whose value is only the diagram body, no @startuml.
  if (uml && isPlantumlKey(n, ctx) && !START_ANYWHERE.test(text)) {
    return diagramPlaceholder(ctx, text);
  }
  const md = ctx.opts.markdown;
  const useMarkdown =
    md === 'all' ||
    (md === 'byKey' &&
      !!n.key &&
      ctx.opts.markdownKeys.some(
        (k) => k.toLowerCase() === n.key!.text.toLowerCase(),
      ));
  if (useMarkdown) {
    return `<div class="val md">${markdownHtml(text, ctx)}</div>`;
  }
  if (uml) {
    const segs = splitPlantUml(text);
    if (segs.some((sg) => sg.type === 'uml')) {
      return segs
        .map((sg) =>
          sg.type === 'uml'
            ? diagramPlaceholder(ctx, sg.source)
            : sg.text.trim() === ''
              ? ''
              : preBlock(sg.text, ctx),
        )
        .join('');
    }
  }
  return preBlock(text, ctx);
}

function markdownHtml(text: string, ctx: RCtx): string {
  return renderMarkdown(
    text,
    {
      breaks: ctx.opts.breakOnSingleNewLine,
      typographer: ctx.opts.enableTypographer,
      linkify: ctx.opts.enableLinkify,
      protocols: ctx.opts.protocols,
    },
    ctx.opts.plantumlEnabled
      ? { diagram: (src) => diagramPlaceholder(ctx, src) }
      : {},
  );
}

function thumbHtml(value: string, ctx: RCtx): string {
  if (ctx.opts.imagePreview === 'off') {
    return '';
  }
  const ref = classifyImageRef(value);
  if (!ref) {
    return '';
  }
  let src: string | undefined;
  if (ref.kind === 'remote') {
    src = ctx.opts.imagePreview === 'all' ? ref.url : undefined;
  } else {
    src = ctx.opts.resolveImage?.(ref.path);
  }
  if (!src) {
    return '';
  }
  return `<a class="thumb" href="#" data-full="${esc(src)}"><img src="${esc(src)}" alt="${esc(value)}" loading="lazy"></a>`;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * A sequence renders as a table when it is a list of ≥2 similar flat records.
 * Returns the column keys, or `null` when a table would not read well.
 */
function tableColumns(seq: YNode, ctx: RCtx): string[] | null {
  if (!ctx.opts.autoTables) {
    return null;
  }
  const rows = seq.children ?? [];
  if (rows.length < 2) {
    return null;
  }
  const cols: string[] = [];
  const seen = new Set<string>();
  let cells = 0;
  for (const row of rows) {
    if (row.type !== 'map' || !row.children?.length || isMasked(row, ctx)) {
      return null;
    }
    const rowKeys = new Set<string>();
    for (const c of row.children) {
      const k = c.key!;
      if (k.kind === 'complex' || k.isMerge || rowKeys.has(k.text)) {
        return null;
      }
      if (c.children?.length || c.scalar?.multiline) {
        return null;
      }
      rowKeys.add(k.text);
      if (!seen.has(k.text)) {
        seen.add(k.text);
        cols.push(k.text);
      }
    }
    if (cols.length > MAX_TABLE_COLUMNS) {
      return null;
    }
    cells += rowKeys.size;
  }
  if (cells / (rows.length * cols.length) < 0.5) {
    return null;
  }
  if (ctx.opts.sortKeys !== 'none') {
    const dir = ctx.opts.sortKeys === 'asc' ? 1 : -1;
    cols.sort(
      (a, b) =>
        dir * a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }
  return cols;
}

function renderTable(seq: YNode, cols: string[], ctx: RCtx): string {
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = (seq.children ?? [])
    .map((row) => {
      const byKey = new Map(row.children!.map((c) => [c.key!.text, c]));
      const cells = cols
        .map((c) => {
          const cell = byKey.get(c);
          if (!cell) {
            return '<td class="absent"></td>';
          }
          const v = valueHtml(cell, ctx, isMasked(cell, ctx));
          const issue = cell.issues?.length ? issueBadge(cell.issues) : '';
          return `<td class="cell" data-ptr="${esc(cell.ptr)}" data-line="${cell.line}">${v.inline}${issue}</td>`;
        })
        .join('');
      const idxCell =
        `<td class="idx">${row.index}${row.anchor ? `<span class="chip anchor" data-anchor="${esc(row.anchor)}">&amp;${esc(row.anchor)}</span>` : ''}${row.issues?.length ? issueBadge(row.issues) : ''}</td>`;
      return `<tr class="${row.issues?.length ? 'has-issue' : ''}" id="${nodeId(ctx, row)}" data-line="${row.line}" data-end="${row.endLine}" data-ptr="${esc(row.ptr)}">${idxCell}${cells}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="grid"><thead><tr><th class="idx">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ */
/* JSON / resolved views                                               */
/* ------------------------------------------------------------------ */

function renderCodeView(
  doc: YDoc,
  ctx: RCtx,
  kind: 'json' | 'resolved',
): string {
  if (isEmptyRoot(doc.root) && doc.json === null) {
    return '<div class="empty">Empty document</div>';
  }
  if (doc.json === undefined) {
    return `<div class="notice sev-error">${kind === 'json' ? 'JSON' : 'Resolved YAML'} is unavailable: ${esc(doc.resolveError ?? 'the document could not be resolved')}.</div>`;
  }
  try {
    if (kind === 'json') {
      const text = toJsonText(doc.json, ctx.opts);
      return `<pre class="code json">${highlightJson(text)}</pre>`;
    }
    const text = toResolvedYaml(doc.json, ctx.opts);
    return `<pre class="code yaml">${highlightYaml(text)}</pre>`;
  } catch (e) {
    return `<div class="notice sev-error">Could not render this view: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function highlightJson(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    out += esc(text.slice(last, at));
    if (m[1] !== undefined) {
      out += m[2]
        ? `<span class="t-key">${esc(m[1])}</span>${esc(m[2])}`
        : `<span class="t-str">${esc(m[1])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="t-bool">${m[3]}</span>`;
    } else if (m[0] === 'null') {
      out += '<span class="t-null">null</span>';
    } else {
      out += `<span class="t-num">${esc(m[0])}</span>`;
    }
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

const YAML_KEY =
  /^(\s*(?:-\s+)*)("(?:\\.|[^"\\])*"|'(?:[^']|'')*'|[^\s#'"\-?:][^:#]*?|-[^\s:][^:#]*?)(:)(?=\s|$)(.*)$/;

function yamlValue(v: string): string {
  const t = v.trim();
  if (t === '') {
    return esc(v);
  }
  const lead = v.slice(0, v.length - v.trimStart().length);
  let cls = 't-str';
  if (/^(true|false)$/.test(t)) {
    cls = 't-bool';
  } else if (/^(null|~)$/.test(t)) {
    cls = 't-null';
  } else if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    cls = 't-num';
  } else if (/^[|>][+-]?\d*$/.test(t)) {
    cls = 't-tag';
  }
  return `${esc(lead)}<span class="${cls}">${esc(t)}</span>`;
}

/** Lightweight line-based YAML highlighter for the resolved view. */
export function highlightYaml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let blockIndent = -1; // indent of the key owning an open block scalar
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === '' || indent > blockIndent) {
        out.push(`<span class="t-str">${esc(line)}</span>`);
        continue;
      }
      blockIndent = -1;
    }
    if (/^\s*#/.test(line)) {
      out.push(`<span class="t-cmt">${esc(line)}</span>`);
      continue;
    }
    const m = YAML_KEY.exec(line);
    if (m) {
      const rest = m[4];
      if (/^\s*[|>][+-]?\d*\s*$/.test(rest)) {
        blockIndent = m[1].replace(/-\s+/g, '  ').length;
      }
      out.push(
        `${esc(m[1])}<span class="t-key">${esc(m[2])}</span>${esc(m[3])}${yamlValue(rest)}`,
      );
      continue;
    }
    const item = /^(\s*-\s+)(.*)$/.exec(line);
    out.push(item ? `${esc(item[1])}${yamlValue(item[2])}` : esc(line));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Outline                                                             */
/* ------------------------------------------------------------------ */

interface TitledEntry {
  title: string;
  node: YNode;
  children: TitledEntry[];
}

/** The tree of titled blocks the Document view shows as headings. */
function titledEntries(
  n: YNode,
  ctx: RCtx,
  depth: number,
  budget: { left: number },
): TitledEntry[] {
  if (depth > 8 || budget.left <= 0) {
    return [];
  }
  if (n.type === 'seq') {
    return (n.children ?? []).flatMap((c) => titledEntries(c, ctx, depth + 1, budget));
  }
  if (n.type !== 'map') {
    return [];
  }
  const kids = n.children ?? [];
  const title = pickTitle(kids, ctx);
  const inner = kids
    .filter(
      (c) =>
        c !== title &&
        !(c.key && inList(ctx.opts.documentMetadataKeys, c.key.text)),
    )
    .flatMap((c) => titledEntries(c, ctx, depth + 1, budget));
  if (!title) {
    return inner;
  }
  budget.left--;
  return [{ title: title.scalar!.text, node: title, children: inner }];
}

function entryList(entries: TitledEntry[], di: number, masks: RegExp[]): string {
  return `<ul>${entries
    .map((e) => {
      const masked = isMasked(e.node, { masks });
      return `<li><a href="#n-${di}-${e.node.nid}" data-target="n-${di}-${e.node.nid}" data-ptr="${esc(e.node.ptr)}" data-line="${e.node.line}"><span class="name">${esc(masked ? MASK : e.title)}</span></a>${e.children.length ? entryList(e.children, di, masks) : ''}</li>`;
    })
    .join('')}</ul>`;
}

function renderOutline(
  parsed: ParsedYaml,
  masks: RegExp[],
  opts: RenderOptions,
): string {
  const parts: string[] = [];
  const multi = parsed.docs.length > 1;
  const wantTree = !opts.views || opts.views.some((v) => v !== 'document');
  const wantDoc = !opts.views || opts.views.includes('document');

  parsed.docs.forEach((doc, di) => {
    const items: string[] = [];
    const root = doc.root;
    if (!isEmptyRoot(root) && root && root.children) {
      const octx: RCtx = { opts, masks, doc: di, idPrefix: 'n', diagrams: new Map() };
      for (const c of root.children.slice(0, 500)) {
        // List items have no key: name them by their title when they have one.
        const itemTitle =
          !c.key && c.type === 'map' ? pickTitle(c.children ?? [], octx) : undefined;
        const label = c.key
          ? c.key.text
          : itemTitle
            ? `[${c.index}] ${isMasked(itemTitle, { masks }) ? MASK : itemTitle.scalar!.text}`
            : `[${c.index}]`;
        const count =
          c.children && c.children.length > 0
            ? `<span class="count">${c.children.length}</span>`
            : '';
        const bad = c.issues?.length ? '<span class="dot sev-error"></span>' : '';
        const hidden = isMasked(c, { masks }) ? ' masked' : '';
        items.push(
          `<li><a href="#n-${di}-${c.nid}" data-target="n-${di}-${c.nid}" data-ptr="${esc(c.ptr)}" data-line="${c.line}" class="${hidden}">${bad}<span class="name">${esc(label)}</span>${count}</a></li>`,
        );
      }
    }
    const keysHtml = `<ul>${items.join('') || '<li class="none">—</li>'}</ul>`;

    let docHtml = keysHtml;
    if (wantDoc && !isEmptyRoot(root) && root) {
      const ctx: RCtx = {
        opts,
        masks,
        doc: di,
        idPrefix: 'n',
        diagrams: new Map(),
      };
      const entries = titledEntries(root, ctx, 0, { left: 500 });
      if (entries.length > 0) {
        docHtml = entryList(entries, di, masks);
      }
    }

    parts.push(
      `<div class="ol-doc" data-doc="${di}"${multi && di > 0 ? ' hidden' : ''}><h4>${multi ? esc(doc.label) : 'Outline'}</h4>` +
        (wantTree ? `<div class="ol ol-tree">${keysHtml}</div>` : '') +
        (wantDoc ? `<div class="ol ol-document">${docHtml}</div>` : '') +
        (doc.anchors.length > 0
          ? `<h4>Anchors</h4><ul>${doc.anchors
              .map(
                (a) =>
                  `<li><a href="#n-${di}-${a.nid}" data-target="n-${di}-${a.nid}" data-ptr="${esc(a.ptr)}" data-line="${a.line}"><span class="name anchor">&amp;${esc(a.name)}</span><span class="count" title="aliases pointing here">${a.usages}</span></a></li>`,
              )
              .join('')}</ul>`
          : '') +
        '</div>',
    );
  });
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* Document view                                                       */
/* ------------------------------------------------------------------ */
/*
 * Reads a YAML file as a *document* instead of a data tree:
 *
 *   id / title / name ...        → the block's heading
 *   metadata / meta / ...        → collapsed "<Kind> metadata" disclosure
 *   text / description / ...     → Markdown prose (inline code, lists, links,
 *                                  ```plantuml fences and @startuml blocks)
 *   everything else              → "key  value" lines, sub-headings, tables
 *
 * Which keys play which role is configurable (documentTitleKeys, …).
 */

const lower = (s: string) => s.toLowerCase();
const inList = (list: string[], key: string) =>
  list.some((k) => lower(k) === lower(key));
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function renderDocView(doc: YDoc, ctx: RCtx): string {
  if (isEmptyRoot(doc.root)) {
    return '<div class="empty">Empty document</div>';
  }
  return `<article class="docview">${docBlock(doc.root as YNode, 2, ctx)}</article>`;
}

function blkAttrs(n: YNode, ctx: RCtx): string {
  return `id="${nodeId(ctx, n)}" data-line="${n.line}" data-end="${n.endLine}" data-ptr="${esc(n.ptr)}"`;
}

function issuesOf(n: YNode): string {
  return n.issues?.length ? issueBadge(n.issues) : '';
}

function pickTitle(kids: YNode[], ctx: RCtx): YNode | undefined {
  for (const k of ctx.opts.documentTitleKeys) {
    const hit = kids.find(
      (c) =>
        c.key &&
        lower(c.key.text) === lower(k) &&
        c.type === 'scalar' &&
        c.scalar?.kind !== 'null' &&
        !c.scalar?.multiline,
    );
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function docBlock(n: YNode, level: number, ctx: RCtx): string {
  if (isMasked(n, ctx)) {
    return docField(n, ctx);
  }
  switch (n.type) {
    case 'map':
      return docMap(n, level, ctx);
    case 'seq':
      return docSeq(n, level, ctx);
    default:
      return n.scalar?.kind === 'string' && n.scalar.text.trim() !== ''
        ? docText(n, ctx)
        : docField(n, ctx);
  }
}

/** `key  value` line for short scalars, aliases and empty containers. */
function docField(n: YNode, ctx: RCtx): string {
  const v = valueHtml(n, ctx, isMasked(n, ctx));
  const label = n.key
    ? `<span class="fk">${esc(n.key.text)}</span>`
    : n.index !== undefined
      ? `<span class="fk idx">${n.index}</span>`
      : '';
  return `<div class="blk fld" ${blkAttrs(n, ctx)}>${label}<span class="fv">${v.inline}</span>${issuesOf(n)}${v.block ?? ''}</div>`;
}

/** A string rendered as Markdown prose; PlantUML inside becomes diagrams. */
function docText(n: YNode, ctx: RCtx, caption?: string): string {
  const text = n.scalar!.text;
  const cap = caption
    ? `<div class="fk cap">${esc(caption)}</div>`
    : '';
  if (
    ctx.opts.plantumlEnabled &&
    isPlantumlKey(n, ctx) &&
    !START_ANYWHERE.test(text)
  ) {
    return `<div class="blk text diagram-only" ${blkAttrs(n, ctx)}>${cap}${diagramPlaceholder(ctx, text)}${issuesOf(n)}</div>`;
  }
  return `<div class="blk text md" ${blkAttrs(n, ctx)}>${cap}${markdownHtml(text, ctx)}${issuesOf(n)}</div>`;
}

function docHeading(title: YNode, level: number, ctx: RCtx): string {
  const lvl = Math.min(Math.max(level, 2), 6);
  const text = isMasked(title, ctx) ? MASK : (title.scalar?.text ?? '');
  const anchor = title.anchor
    ? `<span class="chip anchor" data-anchor="${esc(title.anchor)}">&amp;${esc(title.anchor)}</span>`
    : '';
  return `<h${lvl} class="dh" ${blkAttrs(title, ctx)}>${esc(text)}${anchor}${issuesOf(title)}</h${lvl}>`;
}

function keyHeading(n: YNode, level: number): string {
  const lvl = Math.min(Math.max(level, 2), 6);
  const text = n.key ? n.key.text : n.index !== undefined ? `#${n.index + 1}` : '';
  return `<h${lvl} class="dh key">${esc(text)}</h${lvl}>`;
}

function metaDetails(m: YNode, kind: string, ctx: RCtx): string {
  const key = m.key?.text ?? 'metadata';
  const label = kind ? `${capitalize(kind)} ${lower(key)}` : capitalize(key);
  const rows = sortedChildren(m, ctx)
    .map((c) => commentBefore(c, ctx) + renderNode(c, 1, ctx))
    .join('');
  return `<details class="meta-details" ${blkAttrs(m, ctx)}><summary>${esc(label)}</summary><ul class="tree">${rows}</ul></details>`;
}

/**
 * `wrap=false` returns just the children: the caller already emitted a
 * wrapper carrying this node's id, and ids must stay unique.
 */
function docMap(n: YNode, level: number, ctx: RCtx, wrap = true): string {
  const kids = n.children ?? [];
  if (kids.length === 0) {
    return docField(n, ctx);
  }
  const o = ctx.opts;
  const title = pickTitle(kids, ctx);
  const metas = kids.filter(
    (c) =>
      c !== title &&
      !!c.key &&
      inList(o.documentMetadataKeys, c.key.text) &&
      (c.type === 'map' || c.type === 'seq') &&
      !!c.children?.length,
  );
  // "type: requirement" names the metadata section ("Requirement metadata").
  const kindNode = kids.find(
    (c) =>
      !!c.key &&
      (lower(c.key.text) === 'type' || lower(c.key.text) === 'kind') &&
      c.scalar?.kind === 'string' &&
      !c.scalar.multiline,
  );
  const kind = metas.length > 0 && kindNode ? kindNode.scalar!.text : '';
  const parts: string[] = [];
  if (title) {
    parts.push(docHeading(title, level, ctx));
  }
  for (const m of metas) {
    parts.push(metaDetails(m, kind, ctx));
  }
  for (const c of kids) {
    if (c === title || metas.includes(c) || (kind && c === kindNode)) {
      continue;
    }
    parts.push(docChild(c, level + 1, ctx));
  }
  return wrap
    ? `<section class="blk sec" ${blkAttrs(n, ctx)}>${parts.join('')}</section>`
    : parts.join('');
}

/** A value of a mapping: prose, a field line, or a titled sub-section. */
function docChild(c: YNode, level: number, ctx: RCtx): string {
  if (isMasked(c, ctx)) {
    return docField(c, ctx);
  }
  if (c.type === 'scalar' && c.scalar?.kind === 'string') {
    const text = c.scalar.text;
    const body =
      !!c.key && inList(ctx.opts.documentTextKeys, c.key.text);
    const diagram = ctx.opts.plantumlEnabled && isPlantumlKey(c, ctx);
    if (text.trim() !== '' && (c.scalar.multiline || body || diagram)) {
      // Body-text keys read as plain prose; other keys keep their label.
      return docText(c, ctx, body || diagram ? undefined : c.key?.text);
    }
  }
  if ((c.type === 'map' || c.type === 'seq') && c.children?.length) {
    if (c.type === 'map' && pickTitle(c.children, ctx)) {
      return docMap(c, level, ctx); // its own title is the heading
    }
    if (c.key && inList(ctx.opts.documentFlattenKeys, c.key.text)) {
      // A pure container (`content:`, `items:` …): show what is inside, at the
      // same level, without a heading for the key.
      return `<section class="blk sec" ${blkAttrs(c, ctx)}>${
        c.type === 'map'
          ? docMap(c, level, ctx, false)
          : docSeq(c, level, ctx, false)
      }</section>`;
    }
    return `<section class="blk sec" ${blkAttrs(c, ctx)}>${keyHeading(c, level)}${
      c.type === 'map'
        ? docMap(c, level + 1, ctx, false)
        : docSeq(c, level + 1, ctx, false)
    }</section>`;
  }
  return docField(c, ctx);
}

function docSeq(n: YNode, level: number, ctx: RCtx, wrap = true): string {
  const kids = n.children ?? [];
  if (kids.length === 0) {
    return docField(n, ctx);
  }
  const a = wrap ? ` ${blkAttrs(n, ctx)}` : '';
  const cols = tableColumns(n, ctx);
  if (cols) {
    return `<div class="blk tbl"${a}>${renderTable(n, cols, ctx)}</div>`;
  }
  const flat = kids.every(
    (c) =>
      (c.type === 'scalar' && !c.scalar?.multiline) ||
      c.type === 'alias' ||
      ((c.type === 'map' || c.type === 'seq') && !c.children?.length),
  );
  if (flat) {
    const items = kids
      .map(
        (c) =>
          `<li data-line="${c.line}" data-ptr="${esc(c.ptr)}">${valueHtml(c, ctx, false).inline}${issuesOf(c)}</li>`,
      )
      .join('');
    return `<ul class="blk dl-list"${a}>${items}</ul>`;
  }
  return `<div class="blk items"${a}>${kids
    .map((c) => docItem(c, level, ctx))
    .join('<hr class="sep">')}</div>`;
}

function docItem(c: YNode, level: number, ctx: RCtx): string {
  if (c.type === 'map' && c.children?.length) {
    // Untitled records get a small "#n" caption so items stay distinguishable.
    const cap =
      pickTitle(c.children, ctx) === undefined
        ? `<div class="item-no">#${(c.index ?? 0) + 1}</div>`
        : '';
    return cap + docMap(c, level, ctx);
  }
  return docBlock(c, level, ctx);
}
