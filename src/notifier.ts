import type { DecisionRequest, Notification, QuestionSpec } from "./types.js"
import type { NotifierBehavior } from "./options.js"
import { isInteractiveQuestion } from "./decision.js"

export interface SessionInfo {
  id: string
  title: string
  directory: string
  parentID?: string
  summary?: {
    files: number
    additions: number
    deletions: number
  }
}

export interface OpenCodeEvent {
  type: string
  properties: unknown
}

export type NotifierMode = "notify" | "interactive"

export interface NotifierDependencies {
  mode: NotifierMode
  instanceID: string
  homeDirectory: string
  behavior: NotifierBehavior
  loadSession: (sessionID: string) => Promise<SessionInfo>
  notify: (notification: Notification) => void
  decide: (request: DecisionRequest) => void
  /**
   * Whether anything may be pushed to Feishu right now (the remote switch).
   * While it is off, idle notifications are dropped and requests are kept
   * until they are answered locally or `flushDeferred()` pushes them.
   * Defaults to always on.
   */
  isRemoteEnabled?: () => boolean
  now?: () => number
}

/** How a permission/question request reaches Feishu. */
type Delivery = { type: "decide"; request: DecisionRequest } | { type: "notify"; notification: Notification }

/** Upper bound of requests kept while the remote switch is off. */
const MAX_DEFERRED = 500

interface RootState {
  active: boolean
  startedAt: number
  pending: Set<string>
}

interface PermissionAsked {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

interface QuestionAsked {
  id: string
  sessionID: string
  questions: QuestionSpec[]
}

export function createNotifier(dependencies: NotifierDependencies) {
  const now = dependencies.now ?? Date.now
  const remoteEnabled = dependencies.isRemoteEnabled ?? (() => true)
  const behavior = dependencies.behavior
  const states = new Map<string, RootState>()
  const requestRoot = new Map<string, string>()
  const seenRequestIds = new Set<string>()
  // Requests asked while the remote switch was off, in arrival order.
  const deferred = new Map<string, Delivery>()

  async function handle(event: OpenCodeEvent): Promise<void> {
    switch (event.type) {
      case "session.status":
        return handleStatus(event.properties)
      case "permission.asked":
        return handlePermissionAsked(event.properties)
      case "permission.replied":
      case "permission.answered":
        return settle(stringField(record(event.properties)?.requestID))
      case "question.asked":
        return handleQuestionAsked(event.properties)
      case "question.replied":
      case "question.rejected":
        return settle(stringField(record(event.properties)?.requestID))
      default:
        return
    }
  }

  async function handleStatus(properties: unknown): Promise<void> {
    const props = record(properties)
    const sessionID = stringField(props?.sessionID)
    const status = record(props?.status)
    const statusType = stringField(status?.type)
    if (!sessionID || (statusType !== "busy" && statusType !== "idle")) return

    const { root, source } = await resolveRoot(sessionID)
    if (statusType === "busy") {
      const state = getState(root.id)
      if (!state.active) {
        state.active = true
        state.startedAt = now()
      }
      return
    }

    if (source.parentID) return
    const state = states.get(root.id)
    if (!state?.active || state.pending.size > 0) return

    const durationMs = Math.max(0, now() - state.startedAt)
    states.delete(root.id)
    if (!behavior.notifyOnIdle || durationMs < behavior.minimumDurationMs) return
    // The user is at the terminal; a finished task is not worth a push later.
    if (!remoteEnabled()) return

    dependencies.notify({
      kind: "idle",
      project: formatDirectory(root.directory, dependencies.homeDirectory),
      session: root.title,
      durationMs,
      ...(root.summary ? { summary: root.summary } : {}),
    })
  }

  async function handlePermissionAsked(properties: unknown): Promise<void> {
    const request = parsePermissionAsked(properties)
    if (!request || seenRequestIds.has(request.id)) return
    remember(request.id)

    const { root, source } = await resolveRoot(request.sessionID)
    trackPending(root.id, request.id)
    const project = formatDirectory(root.directory, dependencies.homeDirectory)
    const childSession = source.parentID ? source.title : undefined

    if (dependencies.mode === "interactive" && behavior.permissionRemote) {
      deliver(request.id, {
        type: "decide",
        request: {
          kind: "permission",
          requestID: request.id,
          instanceID: dependencies.instanceID,
          sessionID: request.sessionID,
          directory: source.directory,
          project,
          session: root.title,
          ...(childSession ? { childSession } : {}),
          permission: request.permission,
          patterns: request.patterns,
        },
      })
      return
    }

    if (!behavior.notifyOnPermission) return
    deliver(request.id, {
      type: "notify",
      notification: {
        kind: "permission",
        project,
        session: root.title,
        ...(childSession ? { childSession } : {}),
        permission: request.permission,
        patterns: request.patterns,
      },
    })
  }

  async function handleQuestionAsked(properties: unknown): Promise<void> {
    const request = parseQuestionAsked(properties)
    if (!request || seenRequestIds.has(request.id)) return
    remember(request.id)

    const { root, source } = await resolveRoot(request.sessionID)
    trackPending(root.id, request.id)
    const project = formatDirectory(root.directory, dependencies.homeDirectory)
    const childSession = source.parentID ? source.title : undefined

    if (dependencies.mode === "interactive" && isInteractiveQuestion(request.questions)) {
      deliver(request.id, {
        type: "decide",
        request: {
          kind: "question",
          requestID: request.id,
          instanceID: dependencies.instanceID,
          sessionID: request.sessionID,
          directory: source.directory,
          project,
          session: root.title,
          ...(childSession ? { childSession } : {}),
          questions: request.questions,
        },
      })
      return
    }

    if (!behavior.notifyOnQuestion) return
    deliver(request.id, {
      type: "notify",
      notification: {
        kind: "question",
        project,
        session: root.title,
        ...(childSession ? { childSession } : {}),
        questions: request.questions.map((question) => ({
          header: question.header,
          question: question.question,
          options: question.options.map((option) => option.label),
          // Only sent when it adds something, so a question without descriptions
          // produces the exact same payload as before.
          ...(question.options.some((option) => option.description)
            ? {
                optionDetails: question.options.map((option) =>
                  option.description ? `${option.label} — ${option.description}` : option.label,
                ),
              }
            : {}),
        })),
      },
    })
  }

  /** Push a request now, or keep it until the remote switch is turned on. */
  function deliver(requestID: string, delivery: Delivery): void {
    if (remoteEnabled()) {
      dispatch(delivery)
      return
    }
    deferred.set(requestID, delivery)
    if (deferred.size > MAX_DEFERRED) {
      const oldest = deferred.keys().next().value
      if (oldest !== undefined) deferred.delete(oldest)
    }
  }

  function dispatch(delivery: Delivery): void {
    if (delivery.type === "decide") dependencies.decide(delivery.request)
    else dependencies.notify(delivery.notification)
  }

  /**
   * Push every request that is still waiting for an answer and arrived while
   * the remote switch was off. Each request is pushed at most once.
   */
  function flushDeferred(): number {
    if (deferred.size === 0 || !remoteEnabled()) return 0
    const waiting = [...deferred.values()]
    deferred.clear()
    for (const delivery of waiting) dispatch(delivery)
    return waiting.length
  }

  /** The request was answered (in OpenCode or via Feishu). */
  function settle(requestID: string | undefined): void {
    if (!requestID) return
    deferred.delete(requestID)
    clearPending(requestID)
  }

  function getState(rootID: string): RootState {
    const existing = states.get(rootID)
    if (existing) return existing
    const created: RootState = { active: false, startedAt: now(), pending: new Set<string>() }
    states.set(rootID, created)
    return created
  }

  function trackPending(rootID: string, requestID: string): void {
    getState(rootID).pending.add(requestID)
    requestRoot.set(requestID, rootID)
  }

  function clearPending(requestID: string | undefined): void {
    if (!requestID) return
    const rootID = requestRoot.get(requestID)
    if (!rootID) return
    states.get(rootID)?.pending.delete(requestID)
    requestRoot.delete(requestID)
  }

  async function resolveRoot(sessionID: string): Promise<{ root: SessionInfo; source: SessionInfo }> {
    const source = await dependencies.loadSession(sessionID)
    let current = source
    const visited = new Set([current.id])
    while (current.parentID) {
      if (visited.has(current.parentID)) throw new Error(`Session parent cycle detected for ${sessionID}`)
      visited.add(current.parentID)
      current = await dependencies.loadSession(current.parentID)
    }
    return { root: current, source }
  }

  function remember(requestID: string): void {
    seenRequestIds.add(requestID)
    if (seenRequestIds.size <= 2_000) return
    const oldest = seenRequestIds.values().next().value
    if (oldest) seenRequestIds.delete(oldest)
  }

  return { handle, flushDeferred, deferredCount: () => deferred.size }
}

export function formatDirectory(directory: string, homeDirectory: string): string {
  const home = homeDirectory.replace(/[\\/]+$/, "")
  if (!home || directory === home) return directory === home ? "~" : directory
  if (directory.startsWith(`${home}/`) || directory.startsWith(`${home}\\`)) {
    return `~${directory.slice(home.length)}`
  }
  return directory
}

function parsePermissionAsked(value: unknown): PermissionAsked | undefined {
  const props = record(value)
  const id = stringField(props?.id)
  const sessionID = stringField(props?.sessionID)
  const permission = stringField(props?.permission)
  const patterns = props?.patterns
  if (!id || !sessionID || !permission || !Array.isArray(patterns)) return undefined
  return { id, sessionID, permission, patterns: patterns.filter((item): item is string => typeof item === "string") }
}

function parseQuestionAsked(value: unknown): QuestionAsked | undefined {
  const props = record(value)
  const id = stringField(props?.id)
  const sessionID = stringField(props?.sessionID)
  const rawQuestions = props?.questions
  if (!id || !sessionID || !Array.isArray(rawQuestions)) return undefined
  const questions = rawQuestions.map(parseQuestionSpec).filter((item): item is QuestionSpec => item !== undefined)
  if (questions.length === 0) return undefined
  return { id, sessionID, questions }
}

function parseQuestionSpec(value: unknown): QuestionSpec | undefined {
  const props = record(value)
  const question = stringField(props?.question)
  const header = stringField(props?.header) ?? question
  if (!question) return undefined
  const rawOptions = Array.isArray(props?.options) ? props.options : []
  const options = rawOptions
    .map((option) => {
      const optionRecord = record(option)
      const label = stringField(optionRecord?.label)
      if (!label) return undefined
      return { label, description: stringField(optionRecord?.description) ?? "" }
    })
    .filter((option): option is { label: string; description: string } => option !== undefined)
  return { header: header ?? "", question, options, multiple: props?.multiple === true, custom: props?.custom !== false }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
