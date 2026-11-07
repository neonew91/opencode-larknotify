/**
 * Compile-time checks only. These assertions prove the dual entrypoints still
 * satisfy both official plugin packages after the adapters change.
 */
import type { PluginModule as V1PluginModule } from "@opencode-ai/plugin"
import type { TuiPluginModule as V1TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import type { Rpc } from "@opencode/plugin/rpc"
import type { Plugin as V2TuiPlugin } from "@opencode/plugin/tui"
import server from "../src/index.js"
import { LarkNotifyRpc } from "../src/rpc.js"
import tui from "../src/tui.js"

const _v1Server: V1PluginModule = server
const _v1Tui: V1TuiPluginModule = tui
const _v2Server: V2Plugin.Plugin = server
const _v2Tui: V2TuiPlugin.Definition = tui
const _rpc: Rpc.PortableDefinition = LarkNotifyRpc

void [_v1Server, _v1Tui, _v2Server, _v2Tui, _rpc]
