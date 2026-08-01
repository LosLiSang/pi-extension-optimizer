# pi-extension-optimizer

A Pi package that precompiles installed TypeScript extensions to reduce startup time. It provides a single `/ext-opt` command with build, status, rollback, and measurement workflows.

## Why

Pi loads TypeScript extensions through jiti. Extensions distributed as `.ts` pay runtime transpilation cost on every cold start. This package automatically discovers those extensions, transpiles their source tree to `dist-opt/*.js`, backs up `package.json`, and changes `pi.extensions` to `./dist-opt/index.js`.

It does **not** modify anything automatically during startup. Every mutation is initiated explicitly through `/ext-opt build` or `/ext-opt rollback` and requires confirmation unless `--yes` is supplied.

## Install from a local checkout

```bash
cd /path/to/pi-extension-optimizer
npm install
npm run build
pi install /absolute/path/to/pi-extension-optimizer
```

Local path packages are referenced in place. Keep the checkout and its `node_modules` directory available.

For cross-machine sync, publish/use a Git or npm source instead of an absolute local path:

```bash
pi install git:github.com/USER/pi-extension-optimizer@v0.1.0
# or, after publishing:
pi install npm:pi-extension-optimizer
```

A Git/npm package entry in `settings.json` can be synchronized by pi-sync. Generated `dist-opt` files are intentionally machine-local and are rebuilt with `/ext-opt build` on each machine.

## Commands

```text
/ext-opt              Interactive menu
/ext-opt build        Discover, transpile, back up, and apply optimizations
/ext-opt status       Show optimized / TypeScript / native JS / broken entries
/ext-opt measure      Measure enabled package module-import time in a child process
/ext-opt rollback     Restore package.json from package.json.pi-orig
/ext-opt help         Show command help
```

For non-interactive mutation commands:

```text
/ext-opt build --yes
/ext-opt rollback --yes
```

## Build behavior

- Scans Pi's user package directory from the official `getAgentDir()` API.
- Only packages **enabled in `settings.json`** are touched; disabled/unused packages are never modified.
- Finds packages whose current entry is `.ts`.
- Also recognizes previously optimized packages through `package.json.pi-orig`.
- Uses esbuild transform mode: no bundling, module structure preserved.
- Rewrites explicit relative `.ts` imports to `.js`.
- **Creates `node_modules` junctions** for `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-agent-core`, pointing at the real Pi harness (resolved from `process.execPath`, falling back to `getPackageDir()`). Extensions keep bare harness imports: the static chain is handled by jiti's aliases (same performance as raw `.ts`), and runtime dynamic `import()`/`require()` resolves natively through the junctions. This avoids both the original `Cannot find package` failures and the slowdown of rewriting imports to absolute `file://` URLs (which made jiti reload the harness repeatedly).
- **Transpiles `.ts`-distributed dependency packages** (e.g. `@juicesharp/rpiv-config`) into their own `dist-opt/` and rewrites the extension's imports to point at them. Node refuses to type-strip `.ts` files under `node_modules`. Dependency `package.json` files are never modified.
- Writes output to `<package>/dist-opt/`.
- Creates `<package>/package.json.pi-orig` before the first entry rewrite.
- Applies an entry only when every TypeScript source file transpiles successfully and the target entry exists.

> Junctions are machine-specific (they point at the real harness). Rebuild with `/ext-opt build` after upgrading Pi, reinstalling packages, or moving to another machine — the build re-creates missing junctions automatically.

## Upgrade behavior

`pi update --extensions` or npm reinstall may replace modified package directories. Run:

```text
/ext-opt build
```

again after package updates. Automatic scanning removes the need for a hard-coded package list.

## Rollback

`/ext-opt rollback` restores every currently optimized package that has a `package.json.pi-orig` backup. `dist-opt` files remain on disk but are no longer referenced.

## Measurement

`/ext-opt measure` starts a clean Node child process, reads enabled npm packages from `~/.pi/agent/settings.json`, and reproduces Pi's loader behavior (`createJiti`, independent instance per entry, `moduleCache:false`, serial loading).

Before timing extensions, the runner **preloads the Pi harness** (the same way the real Pi main process already has it loaded). This is important: a cold subprocess pays a one-time ~1.5-2.6s cost to compile `pi-coding-agent` and its shared deps, which the real Pi already paid at startup. After preloading, shared packages hit the Node module registry and are free for every extension. The reported total is therefore the **real startup extension-loading cost**, not a cold-process artifact.

After each entry loads, the runner also executes every relative dynamic `import()` found in the optimized output using native Node loading — this catches runtime failures that static-chain-only checks miss (e.g. extensions whose commands dynamically load modal components).

Filesystem cache state can affect timing results, so compare warmed multi-run values.

## Security

Pi packages run with full system permissions. This package intentionally modifies installed extension `package.json` files and creates generated JavaScript files. Review the source before installation and keep backups. It never uploads files or contacts external services.
