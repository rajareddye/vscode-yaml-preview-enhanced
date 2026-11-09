import * as vscode from 'vscode';
import {
  CompiledSchema,
  ParsedYaml,
  compileSchema,
  markSchemaError,
  matchSchemaMapping,
  parseSchemaText,
  validateParsed,
} from './engine';
import type { Config } from './config';

interface Cached {
  stamp: string;
  compiled: CompiledSchema;
}

const cache = new Map<string, Cached>();
const MAX_SCHEMA_BYTES = 5 * 1024 * 1024;
const REMOTE_TTL_MS = 60_000;

interface Choice {
  ref: string;
  /** Directory relative refs resolve against. */
  base: vscode.Uri;
}

const dirOf = (u: vscode.Uri) => u.with({ path: u.path.replace(/\/[^/]*$/, '') || '/' });

/** Which schema applies to this file? modeline → `schemas` mapping → `schema`. */
export function pickSchema(
  parsed: ParsedYaml,
  doc: vscode.Uri,
  cfg: Config,
): Choice | undefined {
  if (parsed.schemaRef) {
    return { ref: parsed.schemaRef, base: dirOf(doc) };
  }
  const folder = vscode.workspace.getWorkspaceFolder(doc)?.uri ?? dirOf(doc);
  const mapped = matchSchemaMapping(cfg.schemas, doc.path);
  if (mapped) {
    return { ref: mapped, base: folder };
  }
  if (cfg.schema.trim()) {
    return { ref: cfg.schema.trim(), base: folder };
  }
  return undefined;
}

function resolve(choice: Choice): { uri: vscode.Uri; remote: boolean } {
  const ref = choice.ref;
  if (/^https?:\/\//i.test(ref)) {
    return { uri: vscode.Uri.parse(ref), remote: true };
  }
  if (/^file:\/\//i.test(ref)) {
    return { uri: vscode.Uri.parse(ref), remote: false };
  }
  // Absolute path (POSIX or Windows drive) keeps the document's scheme.
  if (/^([a-z]:[\\/]|\/)/i.test(ref)) {
    return { uri: choice.base.with({ path: ref.replace(/\\/g, '/') }), remote: false };
  }
  return { uri: vscode.Uri.joinPath(choice.base, ref), remote: false };
}

async function fetchRemote(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > MAX_SCHEMA_BYTES) {
      throw new Error('the schema is too large');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate `parsed` against the applicable schema, if there is one. Never
 * throws: problems are recorded on `parsed.schema` and shown in the preview.
 */
export async function applySchema(
  parsed: ParsedYaml,
  doc: vscode.Uri,
  cfg: Config,
): Promise<void> {
  const choice = pickSchema(parsed, doc, cfg);
  if (!choice) {
    return;
  }
  try {
    const { uri, remote } = resolve(choice);
    const display = remote ? uri.toString() : uri.scheme === 'file' ? uri.fsPath : uri.toString();
    if (remote && !cfg.allowRemoteSchemas) {
      markSchemaError(
        parsed,
        display,
        'remote schemas are disabled — enable "yaml-preview-enhanced.allowRemoteSchemas" to download them',
      );
      return;
    }
    const key = uri.toString();
    let compiled: CompiledSchema;
    if (remote) {
      const hit = cache.get(key);
      if (hit && Number(hit.stamp) > Date.now()) {
        compiled = hit.compiled;
      } else {
        compiled = compileSchema(parseSchemaText(await fetchRemote(key)));
        cache.set(key, { stamp: String(Date.now() + REMOTE_TTL_MS), compiled });
      }
    } else {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > MAX_SCHEMA_BYTES) {
        throw new Error('the schema is too large');
      }
      const stamp = `${st.mtime}:${st.size}`;
      const hit = cache.get(key);
      if (hit && hit.stamp === stamp) {
        compiled = hit.compiled;
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        compiled = compileSchema(parseSchemaText(new TextDecoder().decode(bytes)));
        cache.set(key, { stamp, compiled });
      }
    }
    validateParsed(parsed, compiled, display);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markSchemaError(
      parsed,
      choice.ref,
      /ENOENT|FileNotFound|EntryNotFound/i.test(msg) ? 'file not found' : msg.split('\n')[0],
    );
  }
}

export function clearSchemaCache(): void {
  cache.clear();
}
