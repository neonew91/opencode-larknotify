# Repository Guide

## Toolchain and verification

- Use Bun for installs and tests: `bun install`, `bun test`. The broker imports `bun:sqlite` and uses `Bun.listen`, so Node or the OpenCode binary cannot replace the real `bun` executable.
- Run the repository's full verification sequence as documented: `bun test`, `bun run typecheck`, `bun run build`, then `npm pack --dry-run`.
- Run one test file with `bun test test/<name>.test.ts`; all tests live under `test/`.
- There are no configured lint, format, dev, codegen, or CI commands; do not invent them.
- `dist/` is ignored generated output, but it is both the published package and the code loaded by OpenCode. Rebuild after source changes before package or plugin checks.
- `bun run build` is two steps: `tsc -p tsconfig.build.json` emits every `src/**/*.ts`, then `bun script/build-tui.ts` bundles `src/tui.tsx` into `dist/tui.js` with `@opentui/solid/bun-plugin`. `tsc` never emits the `.tsx` file (`jsx: preserve`), but `bun run typecheck` checks it.

## Runtime architecture

- `src/index.ts` is a dual server plugin entrypoint. OpenCode 1.19 calls `server(input, options)`; OpenCode 2 calls `setup(ctx)`. The default export carries both properties plus the stable id `opencode.larknotify`. Do not import either plugin SDK at runtime: the V1 host has no `@opencode/plugin`, and the V2 host has no `@opencode-ai/plugin`.
- `src/tui.tsx` is a separate dual TUI entrypoint (`dist/tui.js`, package export `./tui`). 1.19 calls `tui(api, options)` from `tui.json`; 2.x calls `setup(context)`. Keep `server` out of the TUI module: V1 rejects a module that has both `server` and `tui`.
- `src/server/runtime.ts` is the host-neutral core. `src/server/host-v1.ts` and `src/server/host-v2.ts` adapt session loading, logging, permission/question/form replies and the V2 event stream. Keep new OpenCode-specific code in those adapters.
- OpenCode 2 events use `data` and forms instead of questions. `src/opencode/events.ts` normalizes both generations; `form.created` is translated only when `metadata.kind === "question"`. Other forms stay in OpenCode.
- OpenCode 2's Promise plugin context has no public `session.form`. `src/opencode/form-http.ts` writes form replies through the registered local service (only when `service.pid === process.pid`) or explicit `OPENCODE_FEISHU_SERVER_URL`. If neither is available, questions degrade to notification-only; permissions still use `ctx.permission.reply`.
- `src/rpc.ts` is a plain contract with no SDK imports. The V2 server registers `status`/`setRemote`; the V2 TUI calls `context.client.rpc(contract)` and falls back to `remote.json` when RPC is unavailable. Re-read `context.client` on every call because it changes when the server restarts.
- In the TUI, `solid-js` and `@opentui/*` come from the OpenCode host at runtime and must stay external in `script/build-tui.ts`; bundling them breaks the shared renderer. The shared `src/tui/ui.tsx` must stay host-neutral; V1/V2 slot, keymap and theme differences live in `src/tui/v1.tsx` / `src/tui/v2.tsx`.
- The remote switch lives in `src/remote.ts` and is the only thing that decides whether anything reaches Feishu; there is deliberately no plugin option to bypass it. V1 TUI writes `remote.json` atomically and every server plugin polls it every second; V2 TUI prefers the RPC. While it is off, idle notifications are dropped and permission/question deliveries are queued in `src/notifier.ts` until `flushDeferred()` runs on the off→on flip. An environment without the TUI plugin enables pushes by writing the file directly, so the startup log prints that path whenever the switch is off.
- Interactive mode is split across processes: the plugin talks NDJSON over a Unix socket in `src/ipc/`, while `src/broker/` owns Feishu callbacks, cards, SQLite routing state, and the question wizard. The built broker entrypoint is `dist/broker/entry.js`. Protocol 3 adds `sessionID` to `apply` and form replies; keep the broker backward compatible with protocol 1/2 plugins.
- Keep OpenCode 1.x replies in `src/opencode/reply.ts` on the client injected into the plugin; do not construct a separate server URL. OpenCode 2 replies go through the host adapter.
- Preserve broker concurrency guarantees: card actions need random action tokens and must use `RouteStore.claim()` for the atomic `pending -> processing` claim before the existing settlement flow records a terminal state.

## Environment and behavior constraints

- The plugin does not load `.env`; variables must be inherited by the process that launches OpenCode. In OpenCode 2 the server plugin runs in the background service, so Feishu variables must be present in the service environment; restart it with `opencode service restart` after changing them.
- Interactive mode also requires at least one valid `OPENCODE_FEISHU_ALLOWED_OPENID`. Without it, mode selection succeeds but broker startup fails.
- Broker discovery requires a real Bun executable. Set `OPENCODE_FEISHU_BUN` only when auto-detection fails, and point it to an executable path.
- By default, runtime diagnostics are beside `broker.sock` under `$XDG_RUNTIME_DIR/opencode-feishu/` (or the system temp directory); with `OPENCODE_FEISHU_SOCKET`, they use that socket's parent directory. The files are `broker.log`, `broker.db`, `broker.lock`, `broker.token`, and `remote.json`.
- A missing, malformed, symlinked, or foreign-owned `remote.json` means "off". For OpenCode 1.19 the TUI and server must resolve the same path, so both depend on the same `OPENCODE_FEISHU_SOCKET`/`XDG_RUNTIME_DIR`. OpenCode 2's TUI uses RPC first so a remote TUI still controls the server-side switch.
- Remote permission replies intentionally support only `once` and `reject`; do not add `always` to Feishu cards.
- Broker restart or plugin disconnect invalidates pending decisions, and the originating OpenCode process must remain alive while a decision is pending.
- Unit tests use in-memory SQLite and mocked Feishu HTTP; they do not cover a real Feishu/OpenCode end-to-end flow. `test/plugin.test.ts`, `test/v2-host.test.ts` and other plugin-level tests mutate `process.env` and `globalThis.fetch` and restore both afterwards; keep new tests isolated the same way so they never reach the developer's real Feishu setup. `test/typecheck-v2.ts` is a compile-time assertion file for the dual entrypoints, not a runtime test.
