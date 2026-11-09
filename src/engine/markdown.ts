import MarkdownIt from 'markdown-it';
import { PLANTUML_FENCE_LANGS } from './plantuml';
import { isAllowedUrl } from './text';

export interface MarkdownOptions {
  breaks: boolean;
  typographer: boolean;
  linkify: boolean;
  protocols: string[];
}

const cache = new Map<string, MarkdownIt>();

/** Per-render environment. `diagram` turns PlantUML source into HTML. */
export interface MarkdownEnv {
  diagram?: (source: string) => string;
}

/**
 * Markdown renderer for string values.
 *
 * Deliberately locked down, because the input is arbitrary file content:
 * raw HTML is escaped, images are not rendered (they would trigger network
 * requests), and links must use a whitelisted protocol.
 */
export function renderMarkdown(
  src: string,
  opts: MarkdownOptions,
  env: MarkdownEnv = {},
): string {
  const key = JSON.stringify(opts);
  let md = cache.get(key);
  if (!md) {
    md = new MarkdownIt({
      html: false,
      breaks: opts.breaks,
      typographer: opts.typographer,
      linkify: opts.linkify,
    });
    md.disable('image');
    if (opts.linkify) {
      md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
    }
    md.validateLink = (url: string) => {
      const u = url.trim();
      if (/^#/.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) {
        return true; // fragment / relative reference
      }
      return isAllowedUrl(u, opts.protocols);
    };
    // Let the webview route clicks through the host instead of navigating.
    const defaultOpen =
      md.renderer.rules.link_open ??
      ((tokens, idx, o, _env, self) => self.renderToken(tokens, idx, o));
    md.renderer.rules.link_open = (tokens, idx, o, env, self) => {
      const href = tokens[idx].attrGet('href');
      if (href) {
        tokens[idx].attrSet('data-href', href);
        tokens[idx].attrSet('class', 'link');
      }
      return defaultOpen(tokens, idx, o, env, self);
    };

    // ```plantuml fences become diagrams (when the caller supplies `diagram`).
    const defaultFence =
      md.renderer.rules.fence ??
      ((tokens, idx, o, _env, self) => self.renderToken(tokens, idx, o));
    md.renderer.rules.fence = (tokens, idx, o, e, self) => {
      const lang = tokens[idx].info.trim().split(/\s+/)[0].toLowerCase();
      const diagram = (e as MarkdownEnv | undefined)?.diagram;
      if (diagram && PLANTUML_FENCE_LANGS.includes(lang)) {
        return diagram(tokens[idx].content);
      }
      return defaultFence(tokens, idx, o, e, self);
    };

    // Bare `@startuml … @enduml` blocks (no fence) are diagrams too.
    md.block.ruler.before(
      'fence',
      'plantuml_raw',
      (state, startLine, endLine, silent) => {
        if (state.sCount[startLine] - state.blkIndent >= 4) {
          return false;
        }
        const first = state.src.slice(
          state.bMarks[startLine] + state.tShift[startLine],
          state.eMarks[startLine],
        );
        const m = /^@start([a-z]+)\b/i.exec(first);
        if (!m) {
          return false;
        }
        const endRe = new RegExp(`^@end${m[1]}\\b`, 'i');
        let line = startLine + 1;
        for (; line < endLine; line++) {
          const text = state.src.slice(
            state.bMarks[line] + state.tShift[line],
            state.eMarks[line],
          );
          if (endRe.test(text)) {
            break;
          }
        }
        if (line >= endLine) {
          return false; // never closed: leave it as ordinary text
        }
        if (silent) {
          return true;
        }
        const token = state.push('plantuml', '', 0);
        token.content = state.getLines(startLine, line + 1, state.blkIndent, false);
        token.map = [startLine, line + 1];
        state.line = line + 1;
        return true;
      },
      { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
    md.renderer.rules.plantuml = (tokens, idx, _o, e) => {
      const diagram = (e as MarkdownEnv | undefined)?.diagram;
      return diagram
        ? diagram(tokens[idx].content)
        : `<pre><code>${md!.utils.escapeHtml(tokens[idx].content)}</code></pre>`;
    };

    if (cache.size > 16) {
      cache.clear();
    }
    cache.set(key, md);
  }
  return md.render(src, env);
}
