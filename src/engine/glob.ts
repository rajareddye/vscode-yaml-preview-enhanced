function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a glob (`**`, `*`, `?`, `{a,b}`) to a RegExp that is matched against
 * a forward-slash path. Globs that do not start with `/` match any path
 * *suffix* (so `.github/workflows/*.yml` matches an absolute path too).
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re +=
          '(?:' +
          glob
            .slice(i + 1, end)
            .split(',')
            .map(escapeRe)
            .join('|') +
          ')';
        i = end + 1;
        continue;
      }
    }
    re += escapeRe(c);
    i++;
  }
  return new RegExp(`${glob.startsWith('/') ? '^' : '(?:^|/)'}${re}$`, 'i');
}

export function matchGlob(glob: string, filePath: string): boolean {
  return globToRegExp(glob).test(filePath.replace(/\\/g, '/'));
}

/**
 * Pick the schema for `filePath` from a `{ schemaPath: glob | glob[] }` map
 * (the same shape as the `yaml.schemas` setting). First match wins.
 */
export function matchSchemaMapping(
  mapping: Record<string, string | string[]>,
  filePath: string,
): string | undefined {
  for (const [schema, globs] of Object.entries(mapping)) {
    const list = Array.isArray(globs) ? globs : [globs];
    if (list.some((g) => typeof g === 'string' && matchGlob(g, filePath))) {
      return schema;
    }
  }
  return undefined;
}
