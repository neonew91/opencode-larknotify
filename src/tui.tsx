import { PLUGIN_ID } from "./tui/shared.js"
import { v1Tui } from "./tui/v1.js"
import { setupV2Tui } from "./tui/v2.js"

/**
 * OpenCode 1.x calls `tui(api, options)`; OpenCode 2.x calls
 * `setup(context)`. Each host ignores the other property.
 */
const plugin = {
  id: PLUGIN_ID,
  tui: v1Tui,
  setup: setupV2Tui,
}

export default plugin
