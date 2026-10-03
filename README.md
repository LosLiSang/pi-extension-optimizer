<div align="center">

# ⚡ pi-extension-optimizer

**Precompile your TypeScript Pi extensions for dramatically faster startup.**

[![Pi extension](https://img.shields.io/badge/Pi-extension-4B8BBE.svg?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTEyIDJMMiA3djZsMTAgNWwxMC01VjdsLTEwLTV6TTIgMTdsMTAgNWwxMC01di0zbC0xMCA1bC0xMC01djN6Ii8+PC9zdmc+)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/pi-extension-optimizer)](https://www.npmjs.com/package/pi-extension-optimizer)

<br/>

| ⏱️ Extensions load | 🚀 Own startup cost |
|---|---|
| **~13.2s → ~3.0s** (baseline → optimized) | **2558ms → 156ms** |

</div>

---

## ✨ What it does

Pi loads every `.ts` extension through [jiti](https://github.com/unjs/jiti) at each cold start — a full TypeScript compile pass **per file, per startup**, with no disk cache (`moduleCache: false`). If you run several extensions (web access, MCP, status bars…), that adds up to **seconds** of dead time.

`pi-extension-optimizer` precompiles the `.ts` sources of your installed extensions into plain `.js`, and rewires their `pi.extensions` entry to the compiled output. jiti skips `.js` — **zero transpilation at startup**.

- 🔍 **Auto-scans** every enabled package in `settings.json` — no hard-coded lists
- 🛟 **Backs up** each `package.json` (`.pi-orig`) before touching it — one command to roll back
- 🔗 **Shares the running Pi instance** — harness imports (`@earendil-works/pi-coding-agent` etc.) stay bare and `dist-opt/` is marked `"type": "commonjs"`, so Pi's loader resolves them to the *already-running* Pi. No second copy of Pi, no junctions, no `Cannot find package`
- 🔁 **Transpiles `.ts`-distributed dependency packages** (e.g. `@juicesharp/rpiv-config`) that Node refuses to type-strip under `node_modules`
- 🧪 **`measure`** reports the *real* startup cost (preloads the Pi harness, like the actual main process) — not a cold-subprocess artifact
- ⚡ **Lazy `esbuild`** + zero harness-main-package imports keep the optimizer's own startup cost at **~156ms**

## 🚀 Installation

### From npm (recommended)

```bash
pi install npm:pi-extension-optimizer
```

### From git

```bash
pi install git:github.com/LosLiSang/pi-extension-optimizer
```

### From a local checkout

```bash
git clone https://github.com/LosLiSang/pi-extension-optimizer.git
pi install ./pi-extension-optimizer
```

(`dist/` is committed, so no build step is needed — `pi install` handles dependency installation. If you modify sources, run `npm install && npm run build` first.)

Then restart Pi (or `/reload`) and run:

```text
/ext-opt build
```

## 🕹️ Usage

| Command | Action |
|---|---|
| `/ext-opt` | Interactive menu |
| `/ext-opt build` | Discover `.ts` extensions → transpile → back up → apply |
| `/ext-opt status` | Show `optimized / TypeScript / native JS / broken` per package + leftover harness links |
| `/ext-opt measure` | Time the real module-import phase in a clean child process |
| `/ext-opt repair` | Remove harness links left by v0.1.7 and earlier, add missing `commonjs` markers (also runs automatically on startup) |
| `/ext-opt rollback` | Restore every `package.json` from its `.pi-orig` backup |
| `/ext-opt rollback <name>` | Roll back a single package |

Non-interactive mutation commands accept `--yes`:

```text
/ext-opt build --yes
/ext-opt rollback --yes
```

## 📊 Performance

Measured on the author's setup (15 enabled extensions, Pi 0.83.0, real startup timing via `PI_TIMING=1`):

| Phase | Before | After |
|---|---|---|
| Extensions `module import` | **~13.2s** (all `.ts`, jiti transpile) | **~3.0s** (precompiled `.js`) |
| This package's own load | **2558ms** (eager esbuild + harness import) | **156ms** (lazy + zero harness imports) |

The remaining ~3s is dominated by *native `.js` dependencies* each extension brings (e.g. MCP SDK, `pi-tui-kit`) — V8 compilation that no transpile step can remove. Precompilation eliminates the **`.ts` transpile cost**, which is the part that scales with every file of every extension.

## 🛠️ How it works

```text
installed extension (node_modules/pkg)
  │  package.json  pi.extensions: ["./src/index.ts"]
  │
  ▼  /ext-opt build
  ├─ esbuild transform: src/*.ts ──────────► dist-opt/*.js   (no bundling, structure preserved)
  ├─ harness imports ("@earendil-works/pi-coding-agent" …) kept bare
  ├─ dist-opt/package.json  ← { "type": "commonjs" }
  ├─ package.json.pi-orig  ← original package.json backup
  └─ pi.extensions: ["./dist-opt/index.js"]

Pi startup:
  ├─ jiti loads dist-opt/*.js  (precompiled; jiti's fs cache makes its pass cheap)  ⚡
  ├─ harness imports → Pi's virtualModules → the running Pi instance ✓
  └─ factory registers tools/commands  (unchanged)
```

**Why the `commonjs` marker?** The published Pi CLI runs from a bundle and resolves `@earendil-works/*` imports of extensions through in-memory `virtualModules` — the running Pi instance. But extension packages are usually `"type": "module"`, and jiti hands such plain `.js` files to **Node's native `import()`**. From there the whole subtree, including dynamic `import()` (e.g. pi-tool-display's `config-modal → zellij-modal`), is resolved by Node, which only looks in `node_modules`:

| `node_modules/@earendil-works/pi-coding-agent` | Result |
|---|---|
| missing | `Cannot find package '@earendil-works/pi-coding-agent'` |
| junction to Pi (v0.1.7 and earlier created these) | works, but loads a **second, unbundled copy of Pi** (~+3s startup; `instanceof` vs. the main process fails) |

Marking `dist-opt/` as `commonjs` makes Node's native load of these ESM files fail fast, so jiti falls back to loading them itself, and every harness import goes through `virtualModules`. Measured on 9 extensions: **5.4s → 2.2s** startup, with `/tool-display` working and no junction.

Older versions (v0.1.5–0.1.7) also rewrote harness imports to `file:///…/pi-coding-agent/dist/index.js`, which loaded the unbundled copy as well. v0.1.8 removed the rewrite and the junctions.

## 🩹 Troubleshooting: `Cannot find package '@earendil-works/pi-coding-agent' imported from …`

**Cause:** a `dist-opt/` built by v0.1.7 or earlier, without the `commonjs` marker, and no harness junction.

**Fix:** `/ext-opt repair` (or just `/reload` — the optimizer adds missing markers and removes old junctions on every start), then `/reload`. `/ext-opt build --if-needed` also rebuilds unmarked outputs.

## 🔄 Upgrading

Pi package updates or npm reinstalls replace extension directories, reverting entries to `.ts`. Just run **`/ext-opt build`** again — automatic scanning re-optimizes everything.

## ↩️ Rollback

`/ext-opt rollback` restores every currently optimized package from its `.pi-orig` backup; `/ext-opt rollback <name>` targets a single package. `dist-opt/` files remain on disk but are no longer referenced.

## 🔒 Safety

- **Minimal startup work** — the only automatic actions are adding a missing `"type": "commonjs"` to existing `dist-opt/package.json` files and removing harness links left by older versions (idempotent, no-op when clean). Every *mutation* is an explicit command with a confirmation prompt (`--yes` to skip)
- **Only packages enabled in `settings.json`** are touched; disabled/unused packages are never modified
- **Per-package backups** before the first entry rewrite, refreshed on upgrade
- **Entry applied only when** every source file transpiles successfully *and* the target entry exists
- Never uploads data or contacts external services

## 🧰 Development

```bash
npm install
npm run build        # compile src/ → dist/
npm run test:core    # fixture tests (transpile, backup/apply/rollback, dependency-chain, commonjs marker, harness-link cleanup)
```

## 📄 License

[MIT](LICENSE) © LosLiSang
