import type { QuestionSpec } from "../types.js"

/** Common shape consumed by the notifier for either OpenCode plugin API. */
export interface OpenCodeEvent {
  type: string
  properties: unknown
}

/**
 * Normalize an event from OpenCode 1.x (`properties`) or 2.x (`data`) into the
 * shape the notifier already understands. OpenCode 2 removed question events
 * in favour of forms, so question forms are translated back into the question
 * shape here.
 *
 * Unknown and unsupported events are returned unchanged or dropped; this
 * function never throws on a malformed payload.
 */
export function normalizeEvent(raw: unknown): OpenCodeEvent | undefined {
  const event = record(raw)
  const type = stringField(event?.type)
  if (!type) return undefined

  const properties = record(event?.data) ?? record(event?.properties)
  if (!properties) return undefined

  const name = type.replace(/\.v2\./, ".")

  switch (name) {
    case "session.status":
      return { type: "session.status", properties }
    case "session.idle":
      return { type: "session.status", properties: { sessionID: properties.sessionID, status: { type: "idle" } } }
    // OpenCode 2 server plugins do not receive the TUI-derived session.idle and
    // session.status events; the execution lifecycle is what the server emits.
    case "session.execution.started":
      return { type: "session.status", properties: { sessionID: properties.sessionID, status: { type: "busy" } } }
    case "session.execution.succeeded":
    case "session.execution.failed":
      return {
        type: "session.status",
        properties: { sessionID: properties.sessionID, status: { type: "idle" }, terminal: true },
      }
    case "session.execution.interrupted":
      if (properties.reason === "shutdown") return undefined
      return {
        type: "session.status",
        properties: { sessionID: properties.sessionID, status: { type: "idle" }, terminal: true },
      }
    case "permission.asked":
    case "permission.updated":
      return { type: "permission.asked", properties: normalizePermission(properties) }
    case "permission.replied":
    case "permission.answered": {
      const requestID = stringField(properties.requestID) ?? stringField(properties.permissionID)
      const reply = properties.reply ?? properties.response
      return {
        type: name,
        properties: { ...properties, ...(requestID ? { requestID } : {}), ...(reply !== undefined ? { reply } : {}) },
      }
    }
    case "question.asked":
      return { type: "question.asked", properties }
    case "question.replied":
    case "question.rejected":
      return { type: name, properties }
    case "form.created": {
      const question = normalizeQuestionForm(properties)
      return question ? { type: "question.asked", properties: question } : undefined
    }
    case "form.replied":
      return {
        type: "question.replied",
        properties: { sessionID: properties.sessionID, requestID: properties.id },
      }
    case "form.cancelled":
      return {
        type: "question.rejected",
        properties: { sessionID: properties.sessionID, requestID: properties.id },
      }
    default:
      return { type: name, properties }
  }
}

/** Request IDs whose resolution should retract a card that is still waiting. */
export function resolvedRequestID(event: OpenCodeEvent): string | undefined {
  if (
    event.type !== "permission.replied" &&
    event.type !== "permission.answered" &&
    event.type !== "question.replied" &&
    event.type !== "question.rejected"
  ) {
    return undefined
  }
  const props = record(event.properties)
  return stringField(props?.requestID)
}

function normalizePermission(properties: Record<string, unknown>): Record<string, unknown> {
  const permission = stringField(properties.permission) ?? stringField(properties.action) ?? stringField(properties.type)
  const pattern = properties.pattern
  const patterns =
    stringArray(properties.patterns) ??
    stringArray(properties.resources) ??
    (typeof pattern === "string" ? [pattern] : stringArray(pattern)) ??
    []
  return {
    ...properties,
    ...(permission ? { permission } : {}),
    patterns,
  }
}

/**
 * OpenCode 2's question tool creates a form with `metadata.kind === "question"`
 * and one field per question (`q0`, `q1`, ...). Only string and multiselect
 * fields can be answered from the existing Feishu wizard. If any field is of
 * another type (for example an MCP elicitation field), the form is returned
 * as a non-interactive question so the user is only notified.
 */
function normalizeQuestionForm(properties: Record<string, unknown>): Record<string, unknown> | undefined {
  const form = record(properties.form)
  if (!form) return undefined
  const metadata = record(form.metadata)
  if (metadata?.kind !== "question") return undefined

  const id = stringField(form.id)
  const sessionID = stringField(form.sessionID)
  const fields = form.fields
  if (!id || !sessionID || !Array.isArray(fields) || fields.length === 0) return undefined

  const questions = fields
    .map((field, index) => normalizeFormField(field, index))
    .filter((question): question is QuestionSpec => question !== undefined)
  if (questions.length !== fields.length) return undefined

  return {
    id,
    sessionID,
    questions,
    form: true,
  }
}

function normalizeFormField(raw: unknown, index: number): QuestionSpec | undefined {
  const field = record(raw)
  const key = stringField(field?.key)
  if (!key) return undefined

  const header = stringField(field?.title) ?? ""
  const question = stringField(field?.description) || header || `问题 ${index + 1}`
  const type = stringField(field?.type)
  const options = normalizeOptions(field?.options)

  // A field that cannot be encoded by the current wizard stays visible in the
  // notification but cannot be answered from Feishu.
  if ((type !== "string" && type !== "multiselect") || options === undefined) {
    return { header, question, options: [], multiple: false, custom: false, key }
  }

  return {
    header,
    question,
    options,
    multiple: type === "multiselect",
    custom: field?.custom === true,
    key,
    answerType: type,
  }
}

/** Return undefined when an option value is not the label the wizard submits. */
function normalizeOptions(raw: unknown): QuestionSpec["options"] | undefined {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined

  const options: QuestionSpec["options"] = []
  for (const item of raw) {
    const option = record(item)
    const label = stringField(option?.label)
    if (!label) return undefined
    const value = stringField(option?.value)
    if (value !== undefined && value !== label) return undefined
    options.push({ label, description: stringField(option?.description) ?? "" })
  }
  return options
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
