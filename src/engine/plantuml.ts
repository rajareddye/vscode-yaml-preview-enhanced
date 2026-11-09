import { esc } from './html';

/**
 * Pure helpers for inline PlantUML: finding diagrams inside string values,
 * hashing them for caching, and building the HTML that shows a rendered
 * result. Actually *running* PlantUML happens in the extension host
 * (`src/plantuml.ts`); the engine only emits placeholders.
 */

export type UmlSegment =
  | { type: 'text'; text: string }
  | { type: 'uml'; source: string; kind: string };

/** Fence languages that mean "this code block is a PlantUML diagram". */
export const PLANTUML_FENCE_LANGS = ['plantuml', 'puml', 'uml'];

const START_RE = /^[ \t]*@start([a-z]+)\b/i;

/** Remove the indentation shared by all non-blank lines. */
function dedent(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') {
      continue;
    }
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!isFinite(min) || min === 0) {
    return text;
  }
  return lines.map((l) => l.slice(Math.min(min, l.length - l.trimStart().length))).join('\n');
}

/** Does `text` contain at least one closed `@startX … @endX` block? */
export function containsPlantUml(text: string): boolean {
  return splitPlantUml(text).some((s) => s.type === 'uml');
}

/**
 * Split a string value into plain-text and `@startuml … @enduml` segments.
 * Any `@start<kind>` works (uml, mindmap, gantt, salt, wbs, json, yaml, …);
 * a block must be closed by the matching `@end<kind>`.
 */
export function splitPlantUml(text: string): UmlSegment[] {
  const lines = text.split('\n');
  const out: UmlSegment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      out.push({ type: 'text', text: buf.join('\n') });
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const m = START_RE.exec(lines[i]);
    if (m) {
      const kind = m[1].toLowerCase();
      const endRe = new RegExp(`^[ \\t]*@end${kind}\\b`, 'i');
      let j = i + 1;
      while (j < lines.length && !endRe.test(lines[j])) {
        j++;
      }
      if (j < lines.length) {
        flush();
        out.push({
          type: 'uml',
          kind,
          source: dedent(lines.slice(i, j + 1).join('\n')),
        });
        i = j;
        continue;
      }
    }
    buf.push(lines[i]);
  }
  flush();
  return out;
}

/**
 * PlantUML accepts bodies without `@startuml`, but wrapping makes the cache
 * key and the diagram type explicit.
 */
export function ensureStart(source: string): string {
  const s = source.replace(/^\n+|\s+$/g, '');
  return /^[ \t]*@start[a-z]+\b/im.test(s) ? s : `@startuml\n${s}\n@enduml`;
}

/** cyrb53 string hash (+ length) — fast, sync, good enough for cache keys. */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + str.length.toString(36);
}

export interface DiagramResult {
  svg?: string;
  /** Set when no image could be produced. */
  error?: string;
  /** Set when an image was produced but PlantUML also reported a problem. */
  warning?: string;
}

export function looksLikeSvg(s: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(s);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * The SVG is shown through an `<img>` data URI on purpose: an SVG loaded as
 * an image cannot run scripts or fetch resources, and its inline `style`
 * attributes are not subject to the page's Content-Security-Policy.
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}

/** Inner HTML of a diagram `<figure>` for a finished render. */
export function diagramInnerHtml(r: DiagramResult, source: string): string {
  const src = `<details class="uml-src"><summary>PlantUML source</summary><pre>${esc(source)}</pre></details>`;
  if (r.svg && looksLikeSvg(r.svg)) {
    const warn = r.warning
      ? `<div class="uml-note sev-warning">${esc(r.warning)}</div>`
      : '';
    return `${warn}<div class="uml-paper"><img class="uml-img" alt="PlantUML diagram" src="${svgToDataUri(r.svg)}"></div>${src}`;
  }
  return `<div class="uml-note sev-error">${esc(r.error ?? 'The diagram could not be rendered.')}</div>${src}`;
}

/** Markup of a diagram that has not been rendered yet. */
export function diagramPlaceholderHtml(hash: string): string {
  return `<figure class="uml pending" data-uml="${esc(hash)}"><div class="uml-note">Rendering diagram…</div></figure>`;
}

/**
 * JVM chatter that says nothing about the diagram: `java.util.logging` output
 * (a date/time + logger line followed by `INFO:`/`WARNING:`), JVM option
 * notices and SLF4J banners. A harmless "could not create the prefs
 * directory" notice is the usual culprit.
 */
const JVM_NOISE = [
  /^[A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2}:\d{2}\s?(?:[AP]M)?\s/,
  /^(?:INFO|WARNING|SEVERE|CONFIG|FINE):/,
  /^Picked up /,
  /^OpenJDK .* VM warning/,
  /^SLF4J/,
  /^WARNING: /,
];

/**
 * Turn PlantUML's stderr into one readable line. On a syntax error it prints
 * `ERROR`, the line number and the message, one per line — possibly after JVM
 * log noise, so search for it rather than assuming it comes first.
 */
export function describePlantUmlStderr(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex(
    (l, i) => l === 'ERROR' && /^\d+$/.test(lines[i + 1] ?? ''),
  );
  if (at >= 0) {
    const msg = lines[at + 2];
    return `PlantUML reported an error on diagram line ${lines[at + 1]}${msg ? `: ${msg}` : ''}`;
  }
  const meaningful = lines.find((l) => !JVM_NOISE.some((re) => re.test(l)));
  return meaningful?.slice(0, 300);
}
