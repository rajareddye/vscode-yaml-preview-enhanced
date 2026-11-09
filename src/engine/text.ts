import { esc } from './html';

/** `'http://, https://'` → `['http://', 'https://']` (lower-cased, trimmed). */
export function parseProtocols(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is `url` allowed to be opened from the preview?
 * Relative references and fragments are not "opened" (they have no scheme),
 * so only absolute URLs are checked against the whitelist.
 */
export function isAllowedUrl(url: string, protocols: string[]): boolean {
  const u = url.trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/.test(u)) {
    return false;
  }
  return protocols.some((p) => u.startsWith(p));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip punctuation that is almost never part of a URL when it ends a
 * sentence (`see https://x.com.`), but keep a `)` that closes a `(` inside the
 * URL (`https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    if (/[.,;:!?'"\]}>]$/.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    if (url.endsWith(')')) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/**
 * HTML-escape `text`, turning whitelisted absolute URLs into links.
 * Plain text between URLs is escaped separately so a URL's `&` is escaped
 * exactly once in both the visible text and the `href`.
 */
export function linkify(text: string, protocols: string[]): string {
  if (protocols.length === 0 || !text) {
    return esc(text);
  }
  const re = new RegExp(
    `(?:${protocols.map(escapeRegExp).join('|')})[^\\s<>"'\`]+`,
    'gi',
  );
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const url = trimUrl(m[0]);
    // Nothing left after the scheme (e.g. a bare "https://").
    if (!/^[a-z][a-z0-9+.-]*:./i.test(url)) {
      continue;
    }
    const start = m.index ?? 0;
    out += esc(text.slice(last, start));
    out += `<a class="link" href="${esc(url)}" data-href="${esc(url)}">${esc(url)}</a>`;
    last = start + url.length;
  }
  return out + esc(text.slice(last));
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|svg|webp|bmp|ico|avif)(?:[?#].*)?$/i;

export type ImageRef =
  | { kind: 'remote'; url: string }
  | { kind: 'local'; path: string };

/** Does a (single-line) string value look like a reference to an image? */
export function classifyImageRef(value: string): ImageRef | undefined {
  const v = value.trim();
  if (v === '' || v.length > 2000 || /\s/.test(v) || !IMAGE_EXT.test(v)) {
    return undefined;
  }
  if (/^https:\/\//i.test(v)) {
    return { kind: 'remote', url: v };
  }
  // Anything else with a scheme (http:, data:, file:, javascript:) or a
  // protocol-relative / absolute path is not a workspace-relative image.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//') || v.startsWith('/')) {
    return undefined;
  }
  return { kind: 'local', path: v };
}
