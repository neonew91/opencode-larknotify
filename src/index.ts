import type { V1PluginInput } from "./server/host-v1.js"
import { createV1Host } from "./server/host-v1.js"
import { setupV2, type V2PluginContext } from "./server/host-v2.js"
import { createRuntime } from "./server/runtime.js"

const PLUGIN_ID = "opencode.larknotify"

interface V1Hooks {
  event?: (input: { event: unknown }) => Promise<void>
  dispose?: () => Promise<void>
}

/**
 * OpenCode 1.19 also has an internal "config plugin" V2 loader: a module whose
 * default export is `{ id, setup }` is called with a degraded context that has
 * no `event`/`session`/`permission`. Only run the V2 entrypoint when the whole
 * 2.x context is present so 1.19 does not start a second, broken runtime.
 */
function isV2Context(ctx: unknown): ctx is V2PluginContext {
  const value = ctx as Partial<V2PluginContext> | undefined
  return (
    typeof value?.event?.subscribe === "function" &&
    typeof value?.session?.get === "function" &&
    typeof value?.permission?.reply === "function"
  )
}

/** A V1 plugin input always carries the OpenCode client and the project directory. */
function isV1Input(input: unknown): input is V1PluginInput {
  const value = input as Partial<V1PluginInput> | undefined
  return typeof value?.directory === "string" && typeof value?.client === "object" && value?.client !== null
}

/**
 * OpenCode 1.x entrypoint. Returned hooks are the same shape as before; the
 * shared runtime only sees the small V1 host adapter.
 */
const server = async (input: V1PluginInput, options?: Record<string, unknown>): Promise<V1Hooks> => {
  if (!isV1Input(input)) return {}
  const runtime = createRuntime(createV1Host(input, options))
  if (runtime.mode === "disabled") {
    await runtime.dispose()
    return {}
  }
  return {
    event: async ({ event }) => {
      // Keep the V1 hook non-blocking, like the pre-refactor implementation.
      void runtime.handleEvent(event)
    },
    dispose: async () => {
      await runtime.dispose()
    },
  }
}

/**
 * OpenCode 2.x entrypoint. The host calls `setup(ctx)`; 1.19 calls `server()`
 * and its degraded config-plugin loader must not reach this implementation.
 */
const setup = (ctx: V2PluginContext) => (isV2Context(ctx) ? setupV2(ctx) : Promise.resolve(undefined))

const plugin = {
  id: PLUGIN_ID,
  server,
  setup,
}

export default plugin
