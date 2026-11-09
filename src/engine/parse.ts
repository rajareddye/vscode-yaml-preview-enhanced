import {
  Alias,
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  Pair,
  parseAllDocuments,
  Scalar,
  YAMLError,
  YAMLMap,
  YAMLSeq,
} from 'yaml';
import { escapePointerSegment } from './pointer';
import {
  AnchorInfo,
  DEFAULT_PARSE_OPTIONS,
  Issue,
  KeyInfo,
  ParseOptions,
  ParsedYaml,
  ScalarInfo,
  ScalarKind,
  ScalarStyle,
  YDoc,
  YNode,
} from './types';

/** Nodes nested deeper than this are collapsed into a placeholder. */
export const MAX_DEPTH = 200;

interface Ctx {
  lc: LineCounter;
  text: string;
  doc: Document;
  nextNid: number;
  aliases: { node: YNode; alias: Alias }[];
  nodeMap: Map<unknown, YNode>;
  anchors: AnchorInfo[];
}

type Positioned = { range?: [number, number, number] | null };

/** Parse a YAML stream (zero or more `---` separated documents). */
export function parseYaml(
  text: string,
  options: Partial<ParseOptions> = {},
): ParsedYaml {
  const opts: ParseOptions = { ...DEFAULT_PARSE_OPTIONS, ...options };
  const lc = new LineCounter();
  const stream = parseAllDocuments(text, {
    lineCounter: lc,
    merge: true,
    // Warnings are still collected on `doc.warnings`; `silent` only stops the
    // library from also printing them to the extension host's stderr.
    logLevel: 'silent',
    prettyErrors: false,
    version: opts.version,
    uniqueKeys: opts.uniqueKeys,
    customTags: opts.version === '1.2' ? ['binary'] : undefined,
  }) as unknown as Iterable<Document>;
  const parsed = Array.from(stream);

  const docs = parsed.map((doc, i) =>
    buildDoc(doc, i, parsed.length, text, lc, opts),
  );
  let errorCount = 0;
  let warningCount = 0;
  for (const d of docs) {
    errorCount += d.errors.length;
    warningCount += d.warnings.length;
  }
  return {
    docs,
    errorCount,
    warningCount,
    lineCount: text.length === 0 ? 0 : text.split('\n').length,
    text,
    schemaRef: detectSchemaRef(text),
  };
}

/** `# yaml-language-server: $schema=./schema.json` near the top of the file. */
export function detectSchemaRef(text: string): string | undefined {
  const lines = text.split(/\r?\n/, 40);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line === '---') {
      continue;
    }
    if (!line.startsWith('#')) {
      return undefined;
    }
    const m = /^#\s*yaml-language-server\s*:\s*\$schema\s*=\s*(\S+)/i.exec(
      line,
    );
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

function buildDoc(
  doc: Document,
  index: number,
  total: number,
  text: string,
  lc: LineCounter,
  opts: ParseOptions,
): YDoc {
  const ctx: Ctx = {
    lc,
    text,
    doc,
    nextNid: 0,
    aliases: [],
    nodeMap: new Map(),
    anchors: [],
  };

  const errors = doc.errors.map((e) => toIssue(ctx, e, 'error'));
  const warnings = doc.warnings
    .filter(
      (w) => !(opts.ignoreUnknownTagWarnings && w.code === 'TAG_RESOLVE_FAILED'),
    )
    .map((w) => toIssue(ctx, w, 'warning'));

  let root: YNode | null = null;
  if (doc.contents) {
    root = buildNode(ctx, doc.contents, { ptr: '', depth: 0 });
    dedupeLeadComments(root, cleanComment(doc.commentBefore));
  }

  // Aliases may only point backwards, so resolve them once the whole tree
  // (and therefore every anchor) is known.
  const byNid = new Map<number, AnchorInfo>(ctx.anchors.map((a) => [a.nid, a]));
  for (const { node, alias } of ctx.aliases) {
    const target = safeResolve(alias, doc);
    const targetNode = target ? ctx.nodeMap.get(target) : undefined;
    if (targetNode) {
      node.alias = { name: alias.source, targetNid: targetNode.nid };
      const info = byNid.get(targetNode.nid);
      if (info) {
        info.usages++;
      }
    } else {
      node.alias = { name: alias.source, unresolved: true };
      const issue: Issue = {
        severity: 'error',
        message: `Unresolved alias *${alias.source}: no anchor &${alias.source} defined before it`,
        line: node.line,
        col: node.col,
        endLine: node.endLine,
        endCol: node.endCol,
        code: 'UNRESOLVED_ALIAS',
        source: 'yaml',
        ptr: node.ptr,
      };
      errors.push(issue);
      (node.issues ??= []).push(issue);
    }
  }

  let json: unknown;
  let resolveError: string | undefined;
  try {
    json = doc.toJS({ maxAliasCount: opts.maxAliasCount, mapAsMap: false });
  } catch (e) {
    resolveError = e instanceof Error ? firstLine(e.message) : String(e);
  }

  const start = doc.range ? lc.linePos(doc.range[0]).line : 1;
  const endOffset = doc.range ? doc.range[2] : 0;
  const end = Math.max(start, trimEnd(text, doc.range?.[0] ?? 0, endOffset));

  return {
    index,
    label: labelFor(json, index, total),
    root,
    errors,
    warnings,
    schemaIssues: [],
    directives: (doc.directives?.toString() ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    commentBefore: cleanComment(doc.commentBefore),
    commentAfter: cleanComment(doc.comment),
    startLine: start,
    endLine: end,
    json,
    resolveError,
    nodeCount: ctx.nextNid,
    anchors: ctx.anchors,
  };

  function trimEnd(src: string, from: number, to: number): number {
    let e = to;
    while (e > from && (src[e - 1] === '\n' || src[e - 1] === '\r')) {
      e--;
    }
    return lc.linePos(e).line;
  }
}

/**
 * The `yaml` library may attach one leading comment to several nodes along the
 * chain of first children (the document, the sequence, its first mapping and
 * that mapping's first key). Keep it on the outermost node only, otherwise the
 * same comment is shown repeatedly.
 */
function dedupeLeadComments(n: YNode, inherited: string | undefined): void {
  if (n.commentBefore && inherited && n.commentBefore === inherited) {
    delete n.commentBefore;
  }
  const lead = n.commentBefore ?? inherited;
  n.children?.forEach((c, i) => dedupeLeadComments(c, i === 0 ? lead : undefined));
}

function safeResolve(alias: Alias, doc: Document) {
  try {
    return alias.resolve(doc);
  } catch {
    return undefined;
  }
}

function toIssue(
  ctx: Ctx,
  err: YAMLError,
  severity: 'error' | 'warning',
): Issue {
  const [s, e] = err.pos ?? [0, 0];
  const a = ctx.lc.linePos(s);
  const b = ctx.lc.linePos(Math.max(s, e));
  return {
    severity,
    message: firstLine(err.message),
    line: a.line || 1,
    col: a.col || 1,
    endLine: b.line || 1,
    endCol: b.col || 1,
    code: err.code,
    source: 'yaml',
  };
}

interface BuildInfo {
  ptr: string;
  depth: number;
  key?: KeyInfo;
  index?: number;
  /** Offset where the row begins (the key, for map values). */
  startOffset?: number;
  /** Comment lines preceding the row. */
  before?: string;
  /** Fallback line when the node carries no range. */
  fallbackLine?: number;
}

function buildNode(ctx: Ctx, node: unknown, info: BuildInfo): YNode {
  const r = (node as Positioned | null)?.range ?? undefined;
  const startOffset = info.startOffset ?? r?.[0] ?? 0;
  const endOffset = Math.max(startOffset, r?.[1] ?? startOffset);
  const s = ctx.lc.linePos(startOffset);
  const e = ctx.lc.linePos(trimOffset(ctx.text, startOffset, endOffset));

  const out: YNode = {
    nid: ctx.nextNid++,
    ptr: info.ptr,
    type: 'scalar',
    key: info.key,
    index: info.index,
    line: s.line || info.fallbackLine || 1,
    col: s.col || 1,
    endLine: e.line || s.line || 1,
    endCol: e.col || s.col || 1,
  };
  if (info.before) {
    out.commentBefore = info.before;
  }
  if (node !== null && typeof node === 'object') {
    ctx.nodeMap.set(node, out);
  }

  const anyNode = node as {
    anchor?: string;
    tag?: string;
    comment?: string | null;
    commentBefore?: string | null;
  } | null;
  if (anyNode?.tag) {
    out.tag = shortTag(anyNode.tag);
  }
  if (anyNode?.anchor) {
    out.anchor = anyNode.anchor;
    ctx.anchors.push({
      name: anyNode.anchor,
      nid: out.nid,
      ptr: out.ptr,
      line: out.line,
      usages: 0,
    });
  }
  const trailing = cleanComment(anyNode?.comment);
  if (trailing) {
    out.comment = trailing;
  }

  if (info.depth > MAX_DEPTH) {
    out.scalar = {
      kind: 'string',
      text: '… (nesting too deep to display)',
      style: 'plain',
      multiline: false,
    };
    return out;
  }

  if (isAlias(node)) {
    out.type = 'alias';
    out.alias = { name: node.source };
    ctx.aliases.push({ node: out, alias: node });
    return out;
  }

  if (isMap(node)) {
    out.type = 'map';
    out.flow = !!node.flow;
    out.children = buildMapChildren(ctx, node, out, info.depth);
    leadComment(out, node);
    return out;
  }

  if (isSeq(node)) {
    out.type = 'seq';
    out.flow = !!node.flow;
    out.children = buildSeqChildren(ctx, node, out, info.depth);
    leadComment(out, node);
    return out;
  }

  out.type = 'scalar';
  out.scalar = isScalar(node)
    ? classifyScalar(node)
    : { kind: 'null', text: '', style: 'plain', multiline: false };
  return out;
}

/**
 * A comment on the line(s) right after `key:` belongs to the first child of
 * the collection, so show it above that child rather than on the header row.
 */
function leadComment(out: YNode, node: YAMLMap | YAMLSeq) {
  const lead = cleanComment(node.commentBefore);
  const first = out.children?.[0];
  if (lead && first) {
    first.commentBefore = first.commentBefore
      ? `${lead}\n${first.commentBefore}`
      : lead;
  }
}

function buildMapChildren(
  ctx: Ctx,
  map: YAMLMap,
  parent: YNode,
  depth: number,
): YNode[] {
  const children: YNode[] = [];
  for (const item of map.items as Pair[]) {
    const keyNode = item.key as unknown;
    const key = describeKey(ctx, keyNode);
    const keyStart = (keyNode as Positioned | null)?.range?.[0];
    const valueNode = item.value as unknown;
    const before = cleanComment(
      (keyNode as { commentBefore?: string } | null)?.commentBefore,
    );
    const child = buildNode(ctx, valueNode ?? nullScalar(), {
      ptr: `${parent.ptr}/${escapePointerSegment(key.text)}`,
      depth: depth + 1,
      key,
      startOffset: keyStart ?? (valueNode as Positioned | null)?.range?.[0],
      before,
      fallbackLine: parent.line,
    });
    // `key: # comment` is stored on the key node.
    const keyTrailing = cleanComment(
      (keyNode as { comment?: string } | null)?.comment,
    );
    if (keyTrailing && !child.comment) {
      child.comment = keyTrailing;
    }
    children.push(child);
  }
  return children;
}

function buildSeqChildren(
  ctx: Ctx,
  seq: YAMLSeq,
  parent: YNode,
  depth: number,
): YNode[] {
  return (seq.items as unknown[]).map((item, i) => {
    const before = cleanComment(
      (item as { commentBefore?: string } | null)?.commentBefore,
    );
    const child = buildNode(ctx, item ?? nullScalar(), {
      ptr: `${parent.ptr}/${i}`,
      depth: depth + 1,
      index: i,
      before: isMap(item) || isSeq(item) ? undefined : before,
      fallbackLine: parent.line,
    });
    if (before && (isMap(item) || isSeq(item))) {
      // Container items: the comment precedes the `- ` row itself.
      child.commentBefore = before;
    }
    return child;
  });
}

function nullScalar(): Scalar {
  return new Scalar(null);
}

function describeKey(ctx: Ctx, keyNode: unknown): KeyInfo {
  const line = ctx.lc.linePos((keyNode as Positioned | null)?.range?.[0] ?? 0)
    .line;
  if (isScalar(keyNode)) {
    if (typeof keyNode.value === 'symbol') {
      return {
        text: keyNode.source ?? '<<',
        kind: 'merge',
        line,
        isMerge: true,
      };
    }
    const sc = classifyScalar(keyNode);
    const v = keyNode.value;
    return {
      text:
        typeof v === 'string'
          ? v
          : v === null || v === undefined
            ? 'null'
            : v instanceof Date
              ? sc.text
              : String(v),
      kind: sc.kind,
      line,
      anchor: keyNode.anchor || undefined,
      tag: keyNode.tag ? shortTag(keyNode.tag) : undefined,
    };
  }
  if (isAlias(keyNode)) {
    return { text: `*${keyNode.source}`, kind: 'complex', line };
  }
  if (isMap(keyNode) || isSeq(keyNode)) {
    let text: string;
    try {
      text = JSON.stringify(keyNode.toJSON());
    } catch {
      text = '[complex key]';
    }
    return {
      text: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      kind: 'complex',
      line,
    };
  }
  return { text: 'null', kind: 'null', line };
}

const STYLE_BY_TYPE: Record<string, ScalarStyle> = {
  PLAIN: 'plain',
  QUOTE_SINGLE: 'single',
  QUOTE_DOUBLE: 'double',
  BLOCK_LITERAL: 'literal',
  BLOCK_FOLDED: 'folded',
};

export function classifyScalar(s: Scalar): ScalarInfo {
  const v = s.value;
  const style: ScalarStyle = STYLE_BY_TYPE[s.type ?? 'PLAIN'] ?? 'plain';
  const src = typeof s.source === 'string' && s.source !== '' ? s.source : '';
  const plain = (kind: ScalarKind, text: string): ScalarInfo => ({
    kind,
    text,
    style,
    multiline: false,
  });

  if (v === null || v === undefined) {
    return plain('null', src);
  }
  switch (typeof v) {
    case 'boolean':
      return plain('bool', src || String(v));
    case 'number':
      return plain(
        Number.isInteger(v) ? 'int' : 'float',
        src || String(v),
      );
    case 'bigint':
      return plain('int', src || v.toString());
    case 'symbol':
      return plain('merge', '<<');
    case 'string':
      return { kind: 'string', text: v, style, multiline: v.includes('\n') };
    default:
      break;
  }
  if (v instanceof Date) {
    return plain('timestamp', src || v.toISOString());
  }
  if (v instanceof Uint8Array) {
    return plain('binary', `<binary, ${v.length} byte${v.length === 1 ? '' : 's'}>`);
  }
  return plain('string', String(v));
}

function shortTag(tag: string): string {
  return tag.startsWith('tag:yaml.org,2002:')
    ? `!!${tag.slice('tag:yaml.org,2002:'.length)}`
    : tag;
}

function cleanComment(c: string | null | undefined): string | undefined {
  if (!c) {
    return undefined;
  }
  const out = c
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
  return out === '' ? undefined : out;
}

function trimOffset(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && (text[e - 1] === '\n' || text[e - 1] === '\r')) {
    e--;
  }
  return e;
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}

/** Pick a human label for a document from common identifying fields. */
function labelFor(json: unknown, index: number, total: number): string {
  const fallback = `Document ${index + 1}`;
  if (total < 1 || json === null || typeof json !== 'object') {
    return fallback;
  }
  if (Array.isArray(json)) {
    return fallback;
  }
  const obj = json as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  const meta = obj.metadata;
  const metaName =
    meta && typeof meta === 'object'
      ? str((meta as Record<string, unknown>).name)
      : undefined;
  const kind = str(obj.kind);
  const name = metaName ?? str(obj.name) ?? str(obj.title) ?? str(obj.id);
  if (kind && name) {
    return `${kind}/${name}`;
  }
  return name ?? kind ?? fallback;
}
