/**
 * Shared types for the YAML engine.
 *
 * Everything under `src/engine` is pure (no `vscode`, no Node built-ins) so it
 * can run in the desktop extension host, the web extension host, the webview
 * bundle and the unit tests alike.
 */

export type NodeType = 'map' | 'seq' | 'scalar' | 'alias';

export type ScalarKind =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'null'
  | 'timestamp'
  | 'binary'
  | 'merge';

export type ScalarStyle =
  | 'plain'
  | 'single'
  | 'double'
  | 'literal'
  | 'folded';

export type Severity = 'error' | 'warning' | 'info';

/** A problem found while parsing (`yaml`) or validating (`schema`). */
export interface Issue {
  severity: Severity;
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  endLine: number;
  endCol: number;
  code?: string;
  source: 'yaml' | 'schema';
  /** JSON pointer of the offending node, when known. */
  ptr?: string;
}

/** How a node is labelled inside its parent mapping. */
export interface KeyInfo {
  text: string;
  /** `complex` = the key itself is a mapping/sequence (`? [a, b]`). */
  kind: ScalarKind | 'complex';
  line: number;
  anchor?: string;
  tag?: string;
  /** `<<` merge key. */
  isMerge?: boolean;
}

export interface ScalarInfo {
  kind: ScalarKind;
  /** Display text (already stringified, not HTML-escaped). */
  text: string;
  style: ScalarStyle;
  multiline: boolean;
}

export interface AliasInfo {
  name: string;
  /** `nid` of the anchored node, when the alias resolves. */
  targetNid?: number;
  unresolved?: boolean;
}

export interface YNode {
  /** Unique within its document, assigned in depth-first order. */
  nid: number;
  /** RFC 6901 JSON pointer (`/spec/containers/0/name`). */
  ptr: string;
  type: NodeType;
  /** Set when this node is a value of a mapping. */
  key?: KeyInfo;
  /** Set when this node is an item of a sequence. */
  index?: number;
  /** 1-based first source line of the row (the key's line for map values). */
  line: number;
  /** 1-based column where the row starts. */
  col: number;
  endLine: number;
  /** 1-based column just after the node's last character. */
  endCol: number;
  anchor?: string;
  tag?: string;
  /** Flow style (`{a: 1}` / `[1, 2]`). */
  flow?: boolean;
  commentBefore?: string;
  comment?: string;
  children?: YNode[];
  scalar?: ScalarInfo;
  alias?: AliasInfo;
  issues?: Issue[];
}

export interface AnchorInfo {
  name: string;
  nid: number;
  ptr: string;
  line: number;
  /** How many aliases point at this definition. */
  usages: number;
}

export interface YDoc {
  index: number;
  /** Human-readable label for tabs / outline. */
  label: string;
  root: YNode | null;
  errors: Issue[];
  warnings: Issue[];
  /** Schema violations (filled by {@link validateDocs}). */
  schemaIssues: Issue[];
  directives: string[];
  commentBefore?: string;
  commentAfter?: string;
  startLine: number;
  endLine: number;
  /** Fully resolved JS value (anchors/merge keys expanded), if resolvable. */
  json?: unknown;
  /** Why `json` is unavailable (e.g. alias bomb, unresolved alias). */
  resolveError?: string;
  nodeCount: number;
  anchors: AnchorInfo[];
}

export interface ParseOptions {
  version: '1.1' | '1.2';
  maxAliasCount: number;
  uniqueKeys: boolean;
  ignoreUnknownTagWarnings: boolean;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  version: '1.2',
  maxAliasCount: 100,
  uniqueKeys: true,
  ignoreUnknownTagWarnings: true,
};

export interface ParsedYaml {
  docs: YDoc[];
  /** Total issues over all documents (errors + warnings + schema). */
  errorCount: number;
  warningCount: number;
  lineCount: number;
  /** Raw text that was parsed. */
  text: string;
  /** Schema reference discovered in the file's modeline, if any. */
  schemaRef?: string;
  /** Set once a schema has been applied (or failed to load). */
  schema?: SchemaInfo;
}

export interface SchemaInfo {
  /** Where the schema came from, for display (path or URL). */
  source: string;
  /** Present when the schema could not be loaded or compiled. */
  error?: string;
}

export type SortKeys = 'none' | 'asc' | 'desc';
export type ViewName = 'tree' | 'document' | 'json' | 'resolved';
export type MarkdownMode = 'off' | 'byKey' | 'all';
export type ImagePreviewMode = 'off' | 'local' | 'all';

export interface RenderOptions {
  /**
   * Views to render. Defaults to all of them (static export). The live
   * preview passes only the active view and re-renders when it changes, so a
   * big file is not rendered four times over.
   */
  views?: ViewName[];
  expandDepth: number;
  showComments: boolean;
  showLineNumbers: boolean;
  showTypeBadges: boolean;
  autoTables: boolean;
  sortKeys: SortKeys;
  /** Case-insensitive regular expressions (source strings). */
  maskKeys: string[];
  markdown: MarkdownMode;
  markdownKeys: string[];
  breakOnSingleNewLine: boolean;
  enableTypographer: boolean;
  enableLinkify: boolean;
  /** e.g. `['http://', 'https://', 'mailto:']`. */
  protocols: string[];
  imagePreview: ImagePreviewMode;
  /** Map a relative image path to something the webview can load. */
  resolveImage?: (raw: string) => string | undefined;
  /** Render inline PlantUML (`@startuml … @enduml`, ```plantuml fences). */
  plantumlEnabled: boolean;
  /** Keys whose value *is* PlantUML source, even without `@startuml`. */
  plantumlKeys: string[];
  /** Document view: keys that provide a block's heading (first match wins). */
  documentTitleKeys: string[];
  /** Document view: keys rendered as a collapsed "<Kind> metadata" section. */
  documentMetadataKeys: string[];
  /** Document view: keys whose string value is body text, shown without a label. */
  documentTextKeys: string[];
  /**
   * Document view: keys that only *contain* blocks (`content:`, `items:` …).
   * Their children are shown directly, without a heading for the key itself.
   */
  documentFlattenKeys: string[];
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  expandDepth: 4,
  showComments: true,
  showLineNumbers: true,
  showTypeBadges: false,
  autoTables: true,
  sortKeys: 'none',
  maskKeys: [],
  markdown: 'off',
  markdownKeys: [
    'description',
    'summary',
    'notes',
    'readme',
    'body',
    'details',
    'text',
    'content',
    'message',
    'help',
    'doc',
    'docs',
    'documentation',
    'about',
  ],
  // Block scalars are usually hard-wrapped at ~80 columns in the source, so
  // prose should reflow (standard Markdown) rather than keep every break.
  breakOnSingleNewLine: false,
  enableTypographer: false,
  enableLinkify: true,
  protocols: ['http://', 'https://', 'mailto:', 'tel:'],
  imagePreview: 'local',
  plantumlEnabled: true,
  plantumlKeys: ['plantuml', 'puml', 'uml'],
  documentTitleKeys: ['id', 'title', 'name', 'heading', 'label'],
  documentMetadataKeys: ['metadata', 'meta', 'attributes', 'properties', 'info'],
  documentTextKeys: [
    'text',
    'description',
    'content',
    'body',
    'statement',
    'rationale',
    'summary',
    'details',
    'notes',
    'comment',
    'message',
    'requirement',
  ],
  documentFlattenKeys: [
    'content',
    'children',
    'items',
    'sections',
    'blocks',
    'elements',
    'entries',
  ],
};
