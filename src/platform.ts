import type * as vscode from 'vscode';
import type { DiagramResult } from './engine';
import type { Config } from './config';
import type { PlantUmlSettings } from './plantuml-runner';

/**
 * Things that differ between the desktop and the web extension host. The
 * shared code only sees these interfaces; `extension.ts` plugs in the Node
 * implementations and `extension-web.ts` plugs in stubs.
 */
export interface DiagramService {
  render(source: string, settings: PlantUmlSettings): Promise<DiagramResult>;
  clear(): void;
  probe(settings: PlantUmlSettings): Promise<{ ok: boolean; message: string }>;
  dispose(): void;
}

export type CustomFile = 'style.css' | 'config.js' | 'parser.js' | 'head.html';

export interface ParserHooks {
  /** Rewrite the YAML text before it is parsed. */
  onWillParseYaml?: (text: string, ctx: { uri: string }) => string | Promise<string>;
  /** Rewrite the generated HTML before it is shown. */
  onDidParseYaml?: (html: string, ctx: { uri: string }) => string | Promise<string>;
}

export interface Customization {
  /** Extra CSS (global, then workspace). */
  loadCss(resource: vscode.Uri | undefined): Promise<string>;
  /** Extra `<head>` markup (global, then workspace). */
  loadHead(resource: vscode.Uri | undefined): Promise<string>;
  /** Overrides from `config.js` (global, then workspace). */
  loadConfigOverrides(resource: vscode.Uri | undefined, cfg: Config): Promise<unknown>;
  /** Hooks from `parser.js` (global, then workspace). */
  loadParserHooks(resource: vscode.Uri | undefined, cfg: Config): Promise<ParserHooks[]>;
  /** Create the file if needed and open it in the editor. */
  openFile(scope: 'global' | 'workspace', file: CustomFile, cfg: Config): Promise<void>;
}

export interface Platform {
  isWeb: boolean;
  diagrams: DiagramService;
  customization: Customization;
  /** Native only: PDF/PNG/JPEG export and "open in browser". */
  nativeExport?: {
    exportWithChrome(
      html: string,
      kind: 'pdf' | 'png' | 'jpeg',
      outPath: string,
      cfg: Config,
      width: number,
    ): Promise<void>;
    /** Write `html` somewhere temporary and return its path. */
    writeTempHtml(html: string): Promise<string>;
  };
}
