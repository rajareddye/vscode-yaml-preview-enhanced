// esbuild driver.
//   node build.js            one-off development build
//   node build.js --watch    rebuild on change
//   node build.js --production   minified build used for packaging
const { context, build } = require('esbuild');
const { existsSync, rmSync } = require('fs');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
  name: 'esbuild-problem-matcher',
  setup(b) {
    b.onStart(() => console.log('[build] started'));
    b.onEnd((result) => {
      result.errors.forEach((e) =>
        console.error(
          `> ${e.location?.file}:${e.location?.line}:${e.location?.column}: error: ${e.text}`,
        ),
      );
      console.log(
        result.errors.length ? '[build] failed' : '[build] finished',
      );
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [problemMatcher],
};

/** @type {{name: string, entry: string, options: import('esbuild').BuildOptions}[]} */
const targets = [
  {
    // Desktop extension host (Node 18, the floor for VS Code >= 1.82).
    name: 'native',
    entry: 'src/extension.ts',
    options: {
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'out/native/extension.js',
      external: ['vscode'],
    },
  },
  {
    // Web extension host (vscode.dev, github.dev): no Node built-ins.
    name: 'web',
    entry: 'src/extension-web.ts',
    options: {
      platform: 'browser',
      target: 'es2022',
      format: 'cjs',
      outfile: 'out/web/extension.js',
      external: ['vscode'],
      define: { global: 'globalThis' },
    },
  },
  {
    // Script that runs inside the preview webview (and in exported HTML).
    name: 'webview',
    entry: 'src/webview/preview.ts',
    options: {
      platform: 'browser',
      target: 'es2020',
      format: 'iife',
      outfile: 'out/webview/preview.js',
    },
  },
  {
    // The PlantUML runner has no `vscode` dependency, so it is tested directly.
    name: 'plantuml-runner',
    entry: 'src/plantuml-runner.ts',
    options: {
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'out/plantuml-runner/index.js',
    },
  },
  {
    // Integration-test entry: exposes the wiring so tests can inject fakes.
    name: 'host-test',
    entry: 'src/test-entry.ts',
    options: {
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'out/host/index.js',
      external: ['vscode'],
    },
  },
  {
    name: 'chrome-export',
    entry: 'src/chrome-export.ts',
    options: {
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'out/chrome-export/index.js',
    },
  },
  {
    // Plain CommonJS bundle of the pure engine, consumed by the unit tests.
    name: 'engine',
    entry: 'src/engine/index.ts',
    options: {
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: 'out/engine/index.js',
    },
  },
];

async function main() {
  if (!watch) {
    rmSync('out', { recursive: true, force: true });
  }
  const active = targets.filter((t) => existsSync(t.entry));
  const skipped = targets.filter((t) => !existsSync(t.entry));
  skipped.forEach((t) => console.log(`[build] skipping ${t.name} (no ${t.entry})`));

  const ctxs = await Promise.all(
    active.map((t) =>
      context({ ...shared, entryPoints: [t.entry], ...t.options }),
    ),
  );
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[build] watching…');
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
