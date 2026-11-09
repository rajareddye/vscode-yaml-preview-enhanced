import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse as parseYamlValue } from 'yaml';
import { findNodeByPointer, toDotPath } from './pointer';
import { Issue, ParsedYaml, YDoc, YNode } from './types';

export interface CompiledSchema {
  validate: ValidateFunction;
}

const MAX_ISSUES_PER_DOC = 500;

/** Parse a schema file's text (JSON, or YAML — which also covers JSON). */
export function parseSchemaText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseYamlValue(text, { logLevel: 'silent' });
  }
}

function pickAjv(schema: unknown): typeof Ajv {
  const id =
    schema && typeof schema === 'object' && '$schema' in schema
      ? String((schema as { $schema: unknown }).$schema)
      : '';
  if (/2020-12/.test(id)) {
    return Ajv2020 as unknown as typeof Ajv;
  }
  if (/2019-09/.test(id)) {
    return Ajv2019 as unknown as typeof Ajv;
  }
  return Ajv;
}

function build(schema: unknown): ValidateFunction {
  const AjvClass = pickAjv(schema);
  const ajv = new AjvClass({
    allErrors: true,
    strict: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

/**
 * Compile a JSON Schema. Throws an `Error` with a readable message when the
 * schema is not valid. Schemas that declare a meta-schema Ajv does not ship
 * (draft-04/06) are retried without the `$schema` keyword.
 */
export function compileSchema(schema: unknown): CompiledSchema {
  if (schema === null || typeof schema !== 'object') {
    throw new Error('a JSON Schema must be an object');
  }
  try {
    return { validate: build(schema) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/no schema with key or ref/i.test(message) && '$schema' in schema) {
      const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
      return { validate: build(rest) };
    }
    throw new Error(message.split('\n')[0]);
  }
}

/** Dates (YAML 1.1) and BigInts must look like JSON before validation. */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) ??
      'null',
  );
}

function describe(err: ErrorObject): string {
  const where = err.instancePath ? toDotPath(err.instancePath) : 'document';
  switch (err.keyword) {
    case 'additionalProperties':
      return `${where} has unexpected property '${err.params.additionalProperty}'`;
    case 'unevaluatedProperties':
      return `${where} has unevaluated property '${err.params.unevaluatedProperty}'`;
    case 'enum': {
      const allowed = (err.params.allowedValues as unknown[]) ?? [];
      const shown = allowed.slice(0, 8).map((v) => JSON.stringify(v));
      return `${where} must be one of: ${shown.join(', ')}${allowed.length > 8 ? ', …' : ''}`;
    }
    default:
      return `${where} ${err.message ?? 'is invalid'}`;
  }
}

function attach(doc: YDoc, err: ErrorObject): Issue {
  let ptr = err.instancePath;
  const extra =
    (err.params.additionalProperty as string | undefined) ??
    (err.params.unevaluatedProperty as string | undefined);
  let node: YNode | undefined;
  if (extra !== undefined) {
    const child = `${ptr}/${extra.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    node = findNodeByPointer(doc.root, child, { exact: true });
    if (node) {
      ptr = child;
    }
  }
  node ??= findNodeByPointer(doc.root, ptr);
  const issue: Issue = {
    severity: 'error',
    message: describe(err),
    line: node?.line ?? doc.startLine,
    col: node?.col ?? 1,
    endLine: node?.endLine ?? doc.startLine,
    endCol: node?.endCol ?? 1,
    code: err.keyword,
    source: 'schema',
    ptr: node?.ptr ?? ptr,
  };
  if (node) {
    (node.issues ??= []).push(issue);
  }
  return issue;
}

/**
 * Validate every resolvable document against `compiled`. Violations are added
 * to `doc.schemaIssues` and to the offending nodes. Idempotent: clears the
 * results of any earlier run first.
 */
export function validateParsed(
  parsed: ParsedYaml,
  compiled: CompiledSchema,
  source: string,
): void {
  parsed.schema = { source };
  for (const doc of parsed.docs) {
    doc.schemaIssues = [];
    clearSchemaIssues(doc.root);
    if (doc.json === undefined || doc.errors.length > 0) {
      continue;
    }
    const data = toPlainJson(doc.json);
    if (compiled.validate(data)) {
      continue;
    }
    const seen = new Set<string>();
    for (const err of compiled.validate.errors ?? []) {
      if (doc.schemaIssues.length >= MAX_ISSUES_PER_DOC) {
        break;
      }
      const issue = attach(doc, err);
      const key = `${issue.ptr}|${issue.message}`;
      if (seen.has(key)) {
        // Remove the duplicate we just attached to the node.
        const node = findNodeByPointer(doc.root, issue.ptr ?? '', { exact: true });
        if (node?.issues) {
          node.issues = node.issues.filter((i) => i !== issue);
        }
        continue;
      }
      seen.add(key);
      doc.schemaIssues.push(issue);
    }
  }
}

function clearSchemaIssues(node: YNode | null) {
  if (!node) {
    return;
  }
  if (node.issues) {
    node.issues = node.issues.filter((i) => i.source !== 'schema');
    if (node.issues.length === 0) {
      delete node.issues;
    }
  }
  node.children?.forEach(clearSchemaIssues);
}

/** Record that a schema was requested but could not be used. */
export function markSchemaError(
  parsed: ParsedYaml,
  source: string,
  error: string,
): void {
  parsed.schema = { source, error };
}
