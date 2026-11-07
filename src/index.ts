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
 * OpenCode 1.x entrypoint. Returned hooks are the same shape as before; the
 * shared runtime only sees the small V1 host adapter.
 */
const server = async (input: V1PluginInput, options?: Record<string, unknown>): Promise<V1Hooks> => {
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
 * OpenCode 2.x entrypoint. The host calls `setup(ctx)`; V1 calls `server()` and
 * ignores this property. Both implementations share the broker, notifier and
 * remote-switch code via the host adapter.
 */
const setup = (ctx: V2PluginContext) => setupV2(ctx)

const plugin = {
  id: PLUGIN_ID,
  server,
  setup,
}

export default plugin
