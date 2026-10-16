# Repository Guide

## Toolchain and verification

- Use Bun for installs and tests: `bun install`, `bun test`. The broker imports `bun:sqlite` and uses `Bun.listen`, so Node or the OpenCode binary cannot replace the real `bun` executable.
- Run the repository's full verification sequence as documented: `bun test`, `bun run typecheck`, `bun run build`, then `npm pack --dry-run`.
- Run one test file with `bun test test/<name>.test.ts`; all tests live under `test/`.
- There are no configured lint, format, dev, codegen, or CI commands; do not invent them.
- `dist/` is ignored generated output, but it is both the published package and the code loaded by OpenCode. Rebuild after source changes before package or plugin checks.
- `bun run build` is two steps: `tsc -p tsconfig.build.json` emits every `src/**/*.ts`, then `bun script/build-tui.ts` bundles `src/tui.tsx` into `dist/tui.js` with `@opentui/solid/bun-plugin`. `tsc` never emits the `.tsx` file (`jsx: preserve`), but `bun run typecheck` checks it.

## Runtime architecture

- `src/index.ts` is the server plugin entrypoint. It selects interactive mode when `OPENCODE_FEISHU_APP_ID`, `OPENCODE_FEISHU_APP_SECRET`, and `OPENCODE_FEISHU_RECEIVE_ID` are complete; otherwise it falls back to a valid `OPENCODE_FEISHU_WEBHOOK`, or silently disables itself.
- `src/tui.tsx` is a separate TUI plugin entrypoint (`dist/tui.js`, package export `./tui`), configured in `tui.json`, not `opencode.json`. OpenCode requires a TUI module to default-export only `{ id, tui }`; never export `server` from it.
- In `src/tui.tsx`, import only types from `@opencode-ai/plugin`. `solid-js` and `@opentui/*` come from the OpenCode host at runtime and must stay external in `script/build-tui.ts`; bundling them breaks the shared renderer.
- The remote switch lives in `src/remote.ts` and is the only thing that decides whether anything reaches Feishu; there is deliberately no plugin option to bypass it. The TUI writes `remote.json` atomically, every server plugin polls it every second, and it defaults to off. While it is off, idle notifications are dropped and permission/question deliveries are queued in `src/notifier.ts` until `flushDeferred()` runs on the off→on flip. An environment without the TUI plugin enables pushes by writing the file directly, so the startup log prints that path whenever the switch is off.
- Interactive mode is split across processes: the plugin talks NDJSON over a Unix socket in `src/ipc/`, while `src/broker/` owns Feishu callbacks, cards, SQLite routing state, and the question wizard. The built broker entrypoint is `dist/broker/entry.js`.
- Keep OpenCode replies in `src/opencode/reply.ts` on the client injected into the plugin; do not construct a separate server URL.
- Preserve broker concurrency guarantees: card actions need random action tokens and must use `RouteStore.claim()` for the atomic `pending -> processing` claim before the existing settlement flow records a terminal state.

## Environment and behavior constraints

- The plugin does not load `.env`; variables must be inherited by the process that launches OpenCode.
- Interactive mode also requires at least one valid `OPENCODE_FEISHU_ALLOWED_OPENID`. Without it, mode selection succeeds but broker startup fails.
- Broker discovery requires a real Bun executable. Set `OPENCODE_FEISHU_BUN` only when auto-detection fails, and point it to an executable path.
- By default, runtime diagnostics are beside `broker.sock` under `$XDG_RUNTIME_DIR/opencode-feishu/` (or the system temp directory); with `OPENCODE_FEISHU_SOCKET`, they use that socket's parent directory. The files are `broker.log`, `broker.db`, `broker.lock`, `broker.token`, and `remote.json`.
- A missing, malformed, symlinked, or foreign-owned `remote.json` means "off". The TUI plugin and the server plugin must resolve the same path, so both depend on the same `OPENCODE_FEISHU_SOCKET`/`XDG_RUNTIME_DIR`.
- Remote permission replies intentionally support only `once` and `reject`; do not add `always` to Feishu cards.
- Broker restart or plugin disconnect invalidates pending decisions, and the originating OpenCode process must remain alive while a decision is pending.
- Unit tests use in-memory SQLite and mocked Feishu HTTP; they do not cover a real Feishu/OpenCode end-to-end flow. `test/plugin.test.ts` mutates `process.env` and `globalThis.fetch` and restores both afterwards; keep new plugin-level tests isolated the same way so they never reach the developer's real Feishu setup.
