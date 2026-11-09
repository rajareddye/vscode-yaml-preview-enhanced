import { promises as fsp } from 'fs';
import { homedir, platform, tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import type { Config } from './config';
import type { Customization, CustomFile, ParserHooks } from './platform';

/**
 * Desktop implementation of user customisation:
 *
 *   style.css   extra CSS                      (always applied)
 *   head.html   extra <head> markup            (always applied; scripts are
 *                                               blocked by the page's CSP)
 *   config.js   setting overrides              (executes code)
 *   parser.js   onWillParseYaml/onDidParseYaml (executes code)
 *
 * Global files live in the config directory and always apply. Workspace files
 * live in `<workspace>/.yaml-preview-enhanced/`; the two that execute code only
 * run in a *trusted* workspace *and* when `enableScriptExecution` is on.
 */

const TEMPLATES: Record<CustomFile, string> = {
  'style.css': `/* Extra CSS for yaml-preview-enhanced-r. Applied to the preview and to exports.
 * Theme colours are CSS variables, e.g.:
 *
 *   :root { --key: #d73a49; --str: #032f62; }
 *   .docview { max-width: 1100px; }
 */
`,
  'head.html': `<!-- Extra markup for the <head> of the preview, e.g. <link> or <meta>.
     Scripts are blocked by the preview's Content-Security-Policy. -->
`,
  'config.js': `// Overrides for yaml-preview-enhanced-r settings. Values here win over VS Code
// settings. Export an object, or a function that receives the current settings.
//
// module.exports = {
//   defaultView: 'document',
//   defaultExpandDepth: 2,
//   maskKeys: ['password', 'secret', 'token'],
// };
module.exports = {};
`,
  'parser.js': `// Hooks that run around rendering. Both may be async.
module.exports = {
  // Rewrite the YAML text before it is parsed.
  // onWillParseYaml(text, { uri }) { return text; },

  // Rewrite the generated HTML before it is shown.
  // onDidParseYaml(html, { uri }) { return html; },
};
`,
};

export function globalDir(cfg: Pick<Config, 'configPath'>): string {
  if (cfg.configPath.trim()) {
    return cfg.configPath.trim();
  }
  return platform() === 'win32'
    ? join(process.env.USERPROFILE || homedir(), '.yaml-preview-enhanced')
    : join(homedir(), '.local', 'state', 'yaml-preview-enhanced');
}

export class NativeCustomization implements Customization {
  private readonly text = new Map<string, { mtime: number; text: string }>();
  private readonly modules = new Map<string, { mtime: number; exports: unknown }>();
  private warned = new Set<string>();

  constructor(private readonly cfgProvider: () => Config) {}

  private workspaceDir(resource: vscode.Uri | undefined): string | undefined {
    const folder = resource
      ? vscode.workspace.getWorkspaceFolder(resource)
      : vscode.workspace.workspaceFolders?.[0];
    return folder && folder.uri.scheme === 'file'
      ? join(folder.uri.fsPath, '.yaml-preview-enhanced')
      : undefined;
  }

  /** May workspace-level scripts execute? */
  private scriptsAllowed(cfg: Config): boolean {
    return vscode.workspace.isTrusted && cfg.enableScriptExecution;
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      const st = await fsp.stat(path);
      const hit = this.text.get(path);
      if (hit && hit.mtime === st.mtimeMs) {
        return hit.text;
      }
      const text = await fsp.readFile(path, 'utf8');
      this.text.set(path, { mtime: st.mtimeMs, text });
      return text;
    } catch {
      return undefined;
    }
  }

  private async both(
    resource: vscode.Uri | undefined,
    file: CustomFile,
    includeWorkspace: boolean,
  ): Promise<string[]> {
    const cfg = this.cfgProvider();
    const paths = [join(globalDir(cfg), file)];
    const ws = this.workspaceDir(resource);
    if (ws && includeWorkspace) {
      paths.push(join(ws, file));
    }
    const out: string[] = [];
    for (const p of paths) {
      const t = await this.read(p);
      if (t !== undefined) {
        out.push(t);
      }
    }
    return out;
  }

  async loadCss(resource: vscode.Uri | undefined): Promise<string> {
    return (await this.both(resource, 'style.css', true)).join('\n');
  }

  async loadHead(resource: vscode.Uri | undefined): Promise<string> {
    return (await this.both(resource, 'head.html', true)).join('\n');
  }

  private async load(path: string): Promise<unknown> {
    try {
      const st = await fsp.stat(path);
      const hit = this.modules.get(path);
      if (hit && hit.mtime === st.mtimeMs) {
        return hit.exports;
      }
      const req = createRequire(path);
      delete req.cache[path];
      const exports = req(path);
      this.modules.set(path, { mtime: st.mtimeMs, exports });
      return exports;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const key = `${path}:${String(e)}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          void vscode.window.showWarningMessage(
            `yaml-preview-enhanced-r: could not run ${path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return undefined;
    }
  }

  private scriptPaths(resource: vscode.Uri | undefined, file: CustomFile, cfg: Config): string[] {
    const paths = [join(globalDir(cfg), file)];
    const ws = this.workspaceDir(resource);
    if (ws && this.scriptsAllowed(cfg)) {
      paths.push(join(ws, file));
    }
    return paths;
  }

  async loadConfigOverrides(resource: vscode.Uri | undefined, cfg: Config): Promise<unknown> {
    let merged: Record<string, unknown> = {};
    for (const p of this.scriptPaths(resource, 'config.js', cfg)) {
      let mod = await this.load(p);
      if (typeof mod === 'function') {
        try {
          mod = await (mod as (c: Config) => unknown)(cfg);
        } catch (e) {
          void vscode.window.showWarningMessage(`yaml-preview-enhanced-r: ${p} threw: ${String(e)}`);
          mod = undefined;
        }
      }
      if (mod && typeof mod === 'object') {
        merged = { ...merged, ...(mod as Record<string, unknown>) };
      }
    }
    return merged;
  }

  async loadParserHooks(resource: vscode.Uri | undefined, cfg: Config): Promise<ParserHooks[]> {
    const hooks: ParserHooks[] = [];
    for (const p of this.scriptPaths(resource, 'parser.js', cfg)) {
      const mod = await this.load(p);
      if (mod && typeof mod === 'object') {
        hooks.push(mod as ParserHooks);
      }
    }
    return hooks;
  }

  async openFile(scope: 'global' | 'workspace', file: CustomFile, cfg: Config): Promise<void> {
    let dir: string | undefined;
    if (scope === 'global') {
      dir = globalDir(cfg);
    } else {
      dir = this.workspaceDir(vscode.window.activeTextEditor?.document.uri);
      if (!dir) {
        void vscode.window.showWarningMessage(
          'yaml-preview-enhanced-r: open a local folder to use workspace-level customisation.',
        );
        return;
      }
    }
    const path = join(dir, file);
    await fsp.mkdir(dir, { recursive: true });
    try {
      await fsp.access(path);
    } catch {
      await fsp.writeFile(path, TEMPLATES[file], 'utf8');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    await vscode.window.showTextDocument(doc, { preview: false });
    if (scope === 'workspace' && (file === 'config.js' || file === 'parser.js') && !cfg.enableScriptExecution) {
      void vscode.window.showInformationMessage(
        'Workspace scripts only run in a trusted workspace with "yaml-preview-enhanced.enableScriptExecution" turned on.',
      );
    }
  }
}

/** Write HTML to a fresh temp file (for "Open in Browser"). */
export async function writeTempHtml(html: string): Promise<string> {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'yaml-preview-'));
  const path = join(dir, 'preview.html');
  await fsp.writeFile(path, html, 'utf8');
  return path;
}
