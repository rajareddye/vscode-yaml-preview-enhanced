import type { YNode } from './types';

/** RFC 6901 escaping of a single reference token. */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function pointerFromSegments(segments: (string | number)[]): string {
  return segments.map((s) => '/' + escapePointerSegment(String(s))).join('');
}

/** `''` → `[]`, `/a/0` → `['a', '0']`. */
export function parsePointer(ptr: string): string[] {
  if (!ptr) {
    return [];
  }
  return ptr.slice(1).split('/').map(unescapePointerSegment);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * `/spec/containers/0/name` → `spec.containers[0].name`.
 * Keys that are not identifiers use bracket-quote notation: `["a.b"]`.
 * Numeric segments render as `[0]` (valid JS for both arrays and objects).
 */
export function toDotPath(ptr: string): string {
  let out = '';
  for (const seg of parsePointer(ptr)) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
    } else if (IDENT.test(seg)) {
      out += out ? `.${seg}` : seg;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out || '$';
}

/** `/spec/containers/0/name` → `$.spec.containers[0].name`. */
export function toJsonPath(ptr: string): string {
  let out = '$';
  for (const seg of parsePointer(ptr)) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}

/** Look a pointer up in a plain JS value. */
export function getByPointer(value: unknown, ptr: string): unknown {
  let cur: any = value;
  for (const seg of parsePointer(ptr)) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur instanceof Map ? cur.get(seg) : cur[seg];
  }
  return cur;
}

/** Find the node for a pointer; falls back to the closest ancestor. */
export function findNodeByPointer(
  root: YNode | null,
  ptr: string,
  opts: { exact?: boolean } = {},
): YNode | undefined {
  if (!root) {
    return undefined;
  }
  let cur: YNode = root;
  for (const seg of parsePointer(ptr)) {
    const next: YNode | undefined = cur.children?.find((c) =>
      c.key ? c.key.text === seg : String(c.index) === seg,
    );
    if (!next) {
      return opts.exact ? undefined : cur;
    }
    cur = next;
  }
  return cur;
}
