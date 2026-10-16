/**
 * Build the TUI entry (`dist/tui.js`).
 *
 * OpenCode only runs its Solid JSX transform on files outside `node_modules`,
 * so an npm-installed plugin must ship pre-compiled JSX. The host provides
 * `solid-js` and `@opentui/*` at runtime (its runtime-module plugin rewrites
 * those imports), so they stay external and are never bundled.
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const outdir = path.join(root, "dist")

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "tui.tsx")],
  outdir,
  target: "bun",
  format: "esm",
  naming: "[name].js",
  sourcemap: "linked",
  external: ["@opentui/*", "solid-js", "solid-js/*", "@opencode-ai/*"],
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  for (const message of result.logs) console.error(message)
  process.exit(1)
}

await writeFile(
  path.join(outdir, "tui.d.ts"),
  [
    'import type { TuiPluginModule } from "@opencode-ai/plugin/tui"',
    "declare const plugin: TuiPluginModule & { id: string }",
    "export default plugin",
    "",
  ].join("\n"),
)

for (const output of result.outputs) console.log(`built ${path.relative(root, output.path)}`)
