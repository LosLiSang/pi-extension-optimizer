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
- 🔗 **Rewrites harness imports** (`@earendil-works/pi-coding-agent` etc.) to absolute file URLs in the output, so runtime resolution never depends on fragile links — `Cannot find package` errors are structurally impossible for rebuilt extensions
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
| `/ext-opt status` | Show `optimized / TypeScript / native JS / broken` per package + harness junction health |
| `/ext-opt measure` | Time the real module-import phase in a clean child process |
| `/ext-opt repair` | Check and fix harness junctions immediately (fallback mechanism only)
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
  ├─ rewrite harness imports: "@earendil-works/pi-coding-agent" ──► "file:///…/pi-coding-agent/dist/index.js"
  ├─ package.json.pi-orig  ← original package.json backup
  └─ pi.extensions: ["./dist-opt/index.js"]

Pi startup:
  ├─ jiti loads dist-opt/index.js  → .js → NO transpile  ⚡
  ├─ native-loaded subtrees (pure JS ESM handed to native import())
  │    └─ harness imports are file URLs → resolve directly, no node_modules lookup ✓
  └─ factory registers tools/commands  (unchanged)
```

**Why the rewrite?** Some `import()` chains end up in jiti's *native-loading path*: a plain `.js` module inside a `"type": "module"` package is handed to Node's native `import()`, and every bare import *beneath it* (e.g. `@earendil-works/pi-coding-agent` in `zellij-modal.js`) is then resolved by Node's ESM resolver, which only looks in real `node_modules` dirs — but the harness packages live *outside* Pi's `node_modules`. The optimizer rewrites those bare imports to absolute `file:` URLs of the real harness entries (same resolution pi's loader uses), so the native chain resolves directly — **no junction, no fragility**. Junctions are still created as a fallback for old builds and subpath imports, and are self-healed on every Pi start.

## 🩹 Troubleshooting: `Cannot find package '@earendil-works/pi-coding-agent' imported from …`

**Symptom:** an optimized extension's command (e.g. `/tool-display`) throws `Cannot find package '@earendil-works/pi-coding-agent' imported from …\dist-opt\src\zellij-modal.js` — typically right after you install/uninstall/update a Pi package.

**Root cause:** `pi install …` runs `npm` inside `~/.pi/agent/npm`. npm's reify treats the harness junction as *extraneous* — it is not present in `package-lock.json` — and **deletes it**. Native-loaded subtrees of the extension then fail their bare-import resolution with `ERR_MODULE_NOT_FOUND`.

**The fix:** since v0.1.5 the optimizer **rewrites harness bare imports to absolute `file:` URLs** at build time, so rebuilt extensions resolve directly to the real harness and **never depend on the junction** — npm can delete it a thousand times and `/tool-display` keeps working. Junctions remain only as a fallback for builds made by older optimizer versions and subpath imports.

**WSL + nvm note (fixed in v0.1.7):** npm exposes `pi` as a symlink such as `<nvm-prefix>/bin/pi`, while the real package lives under `<nvm-prefix>/lib/node_modules`. Older optimizer builds inspected the unresolved symlink and the wrong `bin/node_modules` location, failed to find the harness, and therefore left bare imports in `dist-opt` even after a rebuild. v0.1.7 resolves the CLI symlink and recognizes the Unix global npm layout.

**If you still see the error:**

```text
pi update npm:pi-extension-optimizer
/ext-opt build --yes   # rebuild all extensions with absolute harness file URLs
/reload
```

For an immediate fallback before upgrading, restart Pi or run `/ext-opt repair` to recreate the missing junction. Rebuilding with v0.1.7+ is the durable fix because the generated files no longer need that junction.

> **Switching between WSL and native Windows:** generated `dist-opt` files contain absolute `file:` URLs to the harness installed on the machine that ran the build. Keep the WSL `~/.pi/agent/npm` tree separate from Windows `%USERPROFILE%\.pi\agent\npm`, and run `/ext-opt build --yes` once in each environment. Do not reuse or copy one environment's generated `dist-opt` tree into the other.

## 🔄 Upgrading

Pi package updates or npm reinstalls replace extension directories, reverting entries to `.ts`. Just run **`/ext-opt build`** again — automatic scanning re-optimizes everything (the build also re-creates any missing junctions).

> ⚠️ **Junction permissions (Windows):** creating junctions requires administrator rights or Developer Mode. If creation fails, the build itself still succeeds (static imports are handled by jiti aliases), but runtime dynamic `import()` of harness packages will fail with `Cannot find package`. Such failures are now surfaced as warnings in the build result — run pi elevated or enable Developer Mode, then rebuild.

## ↩️ Rollback

`/ext-opt rollback` restores every currently optimized package from its `.pi-orig` backup; `/ext-opt rollback <name>` targets a single package. `dist-opt/` files remain on disk but are no longer referenced.

## 🔒 Safety

- **Read-only at startup** — the only automatic action is verifying the harness junctions and repairing them when missing (idempotent, no-op when healthy). Every *mutation* is an explicit command with a confirmation prompt (`--yes` to skip)
- **Only packages enabled in `settings.json`** are touched; disabled/unused packages are never modified
- **Per-package backups** before the first entry rewrite, refreshed on upgrade
- **Entry applied only when** every source file transpiles successfully *and* the target entry exists
- Never uploads data or contacts external services

## 🧰 Development

```bash
npm install
npm run build        # compile src/ → dist/
npm run test:core    # fixture tests (transpile, backup/apply/rollback, dependency-chain, junction behavior)
```

## 📄 License

[MIT](LICENSE) © LosLiSang
