import type { SessionInfo } from "../notifier.js"
import { replyPermission, replyQuestion, rejectQuestion } from "../opencode/reply.js"
import { normalizeSessionInfo } from "../opencode/session.js"
import type { FormAnswer } from "../types.js"
import type { ServerHost } from "./runtime.js"

/** The subset of the OpenCode 1.x plugin input this plugin uses. */
export interface V1PluginInput {
  client: unknown
  directory: string
}

interface V1Client {
  app?: {
    log?: (input: { body: { service: string; level: string; message: string } }) => Promise<unknown>
  }
  session?: {
    get?: (input: { path: { id: string } }) => Promise<{ data?: unknown }>
  }
}

export function createV1Host(input: V1PluginInput, options: Record<string, unknown> | undefined): ServerHost {
  const client = input.client as V1Client
  const api = { client: input.client, directory: input.directory }

  return {
    kind: "v1",
    directory: input.directory,
    options,
    log: async (level, message) => {
      await client.app?.log?.({ body: { service: "opencode-larknotify", level, message } })
    },
    loadSession: async (sessionID): Promise<SessionInfo> => {
      const result = await client.session?.get?.({ path: { id: sessionID } })
      if (!result?.data) throw new Error(`Session not found: ${sessionID}`)
      return normalizeSessionInfo(result.data)
    },
    replyQuestion: (requestID, answers) => replyQuestion(api, requestID, answers),
    rejectQuestion: (requestID) => rejectQuestion(api, requestID),
    replyPermission: (requestID, _sessionID, reply) => replyPermission(api, requestID, reply),
    replyForm: async (_sessionID: string, _formID: string, _answer: FormAnswer) => {
      throw new Error("OpenCode 1.x has no forms")
    },
    cancelForm: async (_sessionID: string, _formID: string) => {
      throw new Error("OpenCode 1.x has no forms")
    },
  }
}
