import * as vscode from 'vscode';
import {
  DEFAULT_RENDER_OPTIONS,
  ParseOptions,
  RenderOptions,
  ViewName,
  parseProtocols,
} from './engine';
import type { ColorScheme } from './engine';
import type { PlantUmlSettings } from './plantuml-runner';

export const SECTION = 'yaml-preview-enhanced';

export type PreviewMode =
  | 'Single Preview'
  | 'Multiple Previews'
  | 'Previews Only';

export interface Config {
  previewMode: PreviewMode;
  scrollSync: boolean;
  liveUpdate: boolean;
  liveUpdateDebounceMs: number;
  automaticallyShowPreviewOfYamlBeingEdited: boolean;
  disableAutoPreviewForUriSchemes: string[];
  disableAutoPreviewForFilePatterns: string[];
  yamlFileExtensions: string[];
  maxFileSize: number;

  previewColorScheme: ColorScheme;
  previewTheme: string;
  defaultView: ViewName;
  defaultExpandDepth: number;
  showComments: boolean;
  showLineNumbers: boolean;
  showTypeBadges: boolean;
  autoTables: boolean;
  sortKeys: 'none' | 'asc' | 'desc';
  maskKeys: string[];
  enablePreviewZenMode: boolean;
  enablePreviewContextMenu: boolean;
  useVSCodeThemeForContextMenu: boolean;

  renderMarkdownInStrings: 'off' | 'byKey' | 'all';
  markdownKeys: string[];
  breakOnSingleNewLine: boolean;
  enableTypographer: boolean;
  enableLinkify: boolean;
  protocolsWhiteList: string;
  imagePreview: 'off' | 'local' | 'all';
  enableImageLightbox: boolean;

  documentTitleKeys: string[];
  documentMetadataKeys: string[];
  documentTextKeys: string[];
  documentFlattenKeys: string[];

  plantumlEnabled: boolean;
  plantumlJarPath: string;
  javaPath: string;
  plantumlSecurityProfile: string;
  plantumlTimeoutMs: number;
  plantumlArgs: string[];
  plantumlKeys: string[];

  yamlVersion: '1.1' | '1.2';
  maxAliasCount: number;
  uniqueKeys: boolean;
  ignoreUnknownTagWarnings: boolean;

  schema: string;
  schemas: Record<string, string | string[]>;
  allowRemoteSchemas: boolean;
  publishDiagnostics: boolean;

  printBackground: boolean;
  exportColorScheme: 'theme' | 'auto';
  chromePath: string;
  chromeArgs: string[];

  configPath: string;
  enableScriptExecution: boolean;
}

/**
 * Fallback values. They MUST match the defaults declared in package.json —
 * test/manifest.test.js enforces that.
 */
export const DEFAULTS: Config = {
  previewMode: 'Single Preview',
  scrollSync: true,
  liveUpdate: true,
  liveUpdateDebounceMs: 300,
  automaticallyShowPreviewOfYamlBeingEdited: false,
  disableAutoPreviewForUriSchemes: ['vscode-notebook-cell'],
  disableAutoPreviewForFilePatterns: [],
  yamlFileExtensions: ['.yaml', '.yml'],
  maxFileSize: 5242880,

  previewColorScheme: 'selectedPreviewTheme',
  previewTheme: 'github-light',
  defaultView: 'tree',
  defaultExpandDepth: 4,
  showComments: true,
  showLineNumbers: true,
  showTypeBadges: false,
  autoTables: true,
  sortKeys: 'none',
  maskKeys: [],
  enablePreviewZenMode: true,
  enablePreviewContextMenu: true,
  useVSCodeThemeForContextMenu: false,

  renderMarkdownInStrings: 'off',
  markdownKeys: DEFAULT_RENDER_OPTIONS.markdownKeys,
  breakOnSingleNewLine: false,
  enableTypographer: false,
  enableLinkify: true,
  protocolsWhiteList: 'http://, https://, mailto:, tel:',
  imagePreview: 'local',
  enableImageLightbox: true,

  documentTitleKeys: DEFAULT_RENDER_OPTIONS.documentTitleKeys,
  documentMetadataKeys: DEFAULT_RENDER_OPTIONS.documentMetadataKeys,
  documentTextKeys: DEFAULT_RENDER_OPTIONS.documentTextKeys,
  documentFlattenKeys: DEFAULT_RENDER_OPTIONS.documentFlattenKeys,

  plantumlEnabled: true,
  plantumlJarPath: '/usr/local/bin/plantuml.jar',
  javaPath: 'java',
  plantumlSecurityProfile: 'SANDBOX',
  plantumlTimeoutMs: 30000,
  plantumlArgs: [],
  plantumlKeys: DEFAULT_RENDER_OPTIONS.plantumlKeys,

  yamlVersion: '1.2',
  maxAliasCount: 100,
  uniqueKeys: true,
  ignoreUnknownTagWarnings: true,

  schema: '',
  schemas: {},
  allowRemoteSchemas: false,
  publishDiagnostics: false,

  printBackground: false,
  exportColorScheme: 'theme',
  chromePath: '',
  chromeArgs: [],

  configPath: '',
  enableScriptExecution: false,
};

/** Read every setting (for `scope`, so folder-level overrides apply). */
export function readConfig(scope?: vscode.Uri): Config {
  const cfg = vscode.workspace.getConfiguration(SECTION, scope);
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS) as Array<keyof Config>) {
    out[key] = cfg.get(key, DEFAULTS[key]);
  }
  return out as unknown as Config;
}

/**
 * Apply overrides from a user `config.js`. Only known keys with a value of the
 * same kind (string / number / boolean / array / object) are accepted, so a
 * typo or a wrong type cannot corrupt the configuration.
 */
export function applyOverrides(base: Config, overrides: unknown): Config {
  if (!overrides || typeof overrides !== 'object') {
    return base;
  }
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(k in DEFAULTS)) {
      continue;
    }
    const d = (DEFAULTS as unknown as Record<string, unknown>)[k];
    const kind = (x: unknown) => (Array.isArray(x) ? 'array' : typeof x);
    if (kind(v) === kind(d)) {
      out[k] = v;
    }
  }
  return out as unknown as Config;
}

export function toParseOptions(c: Config): ParseOptions {
  return {
    version: c.yamlVersion,
    maxAliasCount: c.maxAliasCount,
    uniqueKeys: c.uniqueKeys,
    ignoreUnknownTagWarnings: c.ignoreUnknownTagWarnings,
  };
}

export function toRenderOptions(
  c: Config,
  extra: Partial<RenderOptions> = {},
): RenderOptions {
  return {
    expandDepth: c.defaultExpandDepth,
    showComments: c.showComments,
    showLineNumbers: c.showLineNumbers,
    showTypeBadges: c.showTypeBadges,
    autoTables: c.autoTables,
    sortKeys: c.sortKeys,
    maskKeys: c.maskKeys,
    markdown: c.renderMarkdownInStrings,
    markdownKeys: c.markdownKeys,
    breakOnSingleNewLine: c.breakOnSingleNewLine,
    enableTypographer: c.enableTypographer,
    enableLinkify: c.enableLinkify,
    protocols: parseProtocols(c.protocolsWhiteList),
    imagePreview: c.imagePreview,
    plantumlEnabled: c.plantumlEnabled,
    plantumlKeys: c.plantumlKeys,
    documentTitleKeys: c.documentTitleKeys,
    documentMetadataKeys: c.documentMetadataKeys,
    documentTextKeys: c.documentTextKeys,
    documentFlattenKeys: c.documentFlattenKeys,
    ...extra,
  };
}

export function toPlantUmlSettings(c: Config): PlantUmlSettings {
  return {
    jarPath: c.plantumlJarPath,
    javaPath: c.javaPath,
    securityProfile: c.plantumlSecurityProfile,
    timeoutMs: c.plantumlTimeoutMs,
    extraArgs: c.plantumlArgs,
  };
}

/** Does `ext` (e.g. `.yaml`) count as a YAML file under these settings? */
export function isYamlFileName(name: string, c: Pick<Config, 'yamlFileExtensions'>): boolean {
  const lower = name.toLowerCase();
  return c.yamlFileExtensions.some((e) => lower.endsWith(e.toLowerCase()));
}
