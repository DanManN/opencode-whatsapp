/**
 * opencode <-> WhatsApp Agent Platform bridge. One file for OpenCode V2 (2.x, `setup`) and V1 (1.18.29+, `server`).
 *
 * Chat with an opencode session from a WhatsApp "third-party agent" chat
 * (WhatsApp > Settings > Agents), and answer opencode permission prompts by
 * reacting to them: 👍 once, ✅ always, 👎 reject.
 *
 * Install (V2): opencode plugin add <git spec of this repo>, e.g. git+ssh://git@host/you/repo.git#main
 *   (add ::path:<subdir> when the package lives in a subdirectory of a larger repo).
 * Or copy this file to ~/.config/opencode/plugins/whatsapp-agent.ts.
 * Then put the API key in ~/.config/opencode/whatsapp-agent.key (mode 600) or WHATSAPP_AGENT_API_KEY.
 *
 * V2 works across projects: one bridge per process, and every project the server loads registers with it.
 * Set "experimental": { "location_idle_timeout": false } so idle projects (and the bridge) aren't unloaded.
 * V1 stays in the project it loaded in.
 *
 * Environment:
 *   WHATSAPP_AGENT_API_KEY       API key from the agent's Chat info > API key
 *   WHATSAPP_AGENT_API_KEY_FILE  Key file path (default ~/.config/opencode/whatsapp-agent.key)
 *   WHATSAPP_AGENT_FORWARD       "whatsapp" (default): WhatsApp sees one session at a time, the current one and
 *                                its subagents. "all": approvals and questions from every session.
 *   WHATSAPP_AGENT_AGENT         Optional opencode agent for WhatsApp sessions (e.g. "build")
 *   WHATSAPP_AGENT_MODEL         Optional "providerID/modelID" for WhatsApp sessions
 *   WHATSAPP_AGENT_STATE_DIR     State dir (default ~/.local/state/opencode-whatsapp-agent)
 *
 * API reference: WhatsApp Agent Platform Developer Manual v1 (Aug 25 2026),
 * https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf
 *
 * No runtime imports from opencode packages: both hosts receive the same plain default export
 * (`Plugin.define` in @opencode/plugin is an identity function), so the file loads on either.
 */
import type { Plugin as PluginV1 } from "@opencode-ai/plugin"
import type { Plugin as PluginV2 } from "@opencode/plugin"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const DEFAULT_BASE_URL = "https://api.whatsapp.com/agent/v1"
const MAX_TEXT = 4096 // platform cap per text message
const CHUNK = 3900 // leave room for the "(i/n)" suffix
const MAX_CHUNKS = 5 // 12 sends/min: keep one reply under ~30s
const GLOBAL_KEY = Symbol.for("opencode.whatsapp-agent.bridge")
const REGISTRY_KEY = Symbol.for("opencode.whatsapp-agent.v2-registry")

/**
 * V2 plugins can't answer forms yet (anomalyco/opencode#59655 adds ctx.session.form). Until then WhatsApp
 * sessions get a rule denying the question tool, so the model asks in plain text. Set to false once that
 * lands: the deny rule goes away and question forms are forwarded through ctx.session.form instead.
 */
const QUESTION_GUARD = true

type ContextV2 = PluginV2.Context
type Reply = "once" | "always" | "reject"
type Level = "debug" | "info" | "warn" | "error"

type Options = {
  apiKey?: string
  baseUrl?: string
  stateDir?: string
  forward?: "whatsapp" | "all"
  sendIntervalMs?: number // 12 sends/min and 12 statuses/min per agent
  pollFloorMs?: number // 15 polls/min per agent
  pollTimeoutSec?: number // 0-25
  questionGuard?: boolean // tests only; defaults to QUESTION_GUARD
}
type BridgeOpts = Required<Pick<Options, "forward" | "sendIntervalMs" | "pollFloorMs" | "pollTimeoutSec" | "questionGuard">>

/** Permission request, normalized across V1 (permission/patterns/always) and V2 (action/resources/save). */
type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  directory?: string // V2: the project that raised it (replies go through that project's plugin context)
}

/** One question, from V1's question tool or a V2 question form. */
type Question = {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiple?: boolean
  custom?: boolean
}

/** A question request plus how to answer it: V1 posts to the server, V2 replies to the form. */
type QuestionRequest = {
  id: string
  sessionID: string
  questions: Question[]
  answer(answers: string[][]): Promise<boolean>
  dismiss(): Promise<boolean>
}

type QuestionState = { req: QuestionRequest; index: number; answers: string[][]; wamid?: string }

type SessionRef = { id: string; title?: string; parentID?: string; updated: number; directory?: string }
type ModelRef = { providerID: string; modelID: string; name?: string }

const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`

/** The opencode operations the bridge needs; one adapter per plugin API version. */
interface Host {
  /** V2: sessions in any project. V1: only the project the plugin loaded in. */
  readonly multiProject: boolean
  log(level: Level, message: string, extra?: object): void
  getSession(id: string): Promise<SessionRef | undefined>
  /** `directory` is where to create it (V2); V1 always uses its own project. */
  createSession(title: string, directory?: string): Promise<SessionRef | undefined>
  listSessions(): Promise<SessionRef[]>
  /**
   * Starts a turn without waiting for it. `model` is the model picked with /model (V1 sends it per prompt;
   * V2 ignores it because /model already switched the session). Resolves to an error description, or undefined.
   */
  prompt(sessionID: string, text: string, model?: ModelRef): Promise<string | undefined>
  /** Chat models from configured providers (V2: as configured for `directory`). */
  listModels(directory?: string): Promise<ModelRef[]>
  /** The model new sessions get when nothing else is chosen. */
  defaultModel(directory?: string): Promise<ModelRef | undefined>
  /** The model the session currently uses, when the host can tell. */
  sessionModel(sessionID: string): Promise<ModelRef | undefined>
  /** Switches the session's model. Resolves to an error description, or undefined. */
  setModel(sessionID: string, model: ModelRef): Promise<string | undefined>
  abort(sessionID: string): Promise<void>
  /** Text of the last assistant message created at or after `since`. */
  finalReply(sessionID: string, since: number): Promise<{ text: string; error?: string }>
  /** Resolves to false when the request no longer exists. */
  reply(req: PermissionRequest, reply: Reply): Promise<boolean>
  /** V2: adds a session rule denying the question tool. Resolves to an error description, or undefined. */
  denyQuestions?(sessionID: string): Promise<string | undefined>
  /** V2: removes that rule again (the last matching one). Resolves to an error description, or undefined. */
  allowQuestions?(sessionID: string): Promise<string | undefined>
}

// Session rules are evaluated last and the last match wins, so this overrides agent/config rules.
const DENY_QUESTION = { action: "question", resource: "*", effect: "deny" } as const
const isDenyQuestion = (r: any) => r?.action === "question" && r.resource === "*" && r.effect === "deny"

type State = {
  offset?: number
  creator?: string // "user:<id>", learned from a verified inbound message
  sessions: Record<string, string> // V1: directory -> current session id; V2: "*" -> current session id
  cwd?: string // V2: where /new and first messages create sessions (set with /cd)
  models: Record<string, ModelRef> // session id -> model picked with /model (bounded)
}

type WaMessage = {
  from: string
  id: string
  timestamp?: string
  type: string
  text?: { body?: string }
  reaction?: { message_id?: string; emoji?: string }
  context?: { id?: string; from?: string }
}

// ---------------------------------------------------------------- helpers

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })

function clip(text: string, max: number) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

// Text inside ``` blocks can't contain ``` or the block breaks.
const fence = (text: string, max: number) => "```" + clip(text.replaceAll("```", "'''"), max) + "```"

/** Markdown -> WhatsApp formatting (WhatsApp is not Markdown: *bold*, _italic_, ~strike~). */
function toWhatsApp(md: string) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith("```")) return part.replace(/^```[\w+-]*\n/, "```\n")
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "_$1_")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    })
    .join("")
}

/** Split on paragraph, then line, then hard boundaries. */
function chunk(text: string, size = CHUNK) {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size)
    if (cut < size / 2) cut = rest.lastIndexOf("\n", size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** Strip variation selectors and skin tones so 👍🏽 counts as 👍. */
function reactionToReply(emoji: string): Reply | undefined {
  const e = emoji.replace(/[\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "")
  if (e === "👍" || e === "👌") return "once"
  if (e === "✅" || e === "✔" || e === "🔁") return "always"
  if (e === "👎" || e === "❌" || e === "🚫") return "reject"
  return undefined
}

function textToReply(text: string): Reply | undefined {
  const t = text.trim().toLowerCase()
  if (["y", "yes", "ok", "once"].includes(t)) return "once"
  if (["a", "always"].includes(t)) return "always"
  if (["n", "no", "reject", "deny"].includes(t)) return "reject"
  return reactionToReply(text.trim())
}

function describePermission(p: PermissionRequest) {
  const md = p.metadata ?? {}
  const lines = [`🔐 *${p.permission}* permission`]
  if (typeof md.command === "string") lines.push(fence(md.command, 1500))
  else if (typeof md.filepath === "string") {
    lines.push("`" + clip(md.filepath, 300) + "`")
    if (typeof md.diff === "string" && md.diff.trim()) lines.push(fence(md.diff, 1800))
  } else if (typeof md.url === "string") lines.push(clip(md.url, 500))
  else if (p.patterns?.length) lines.push(fence(p.patterns.join("\n"), 1500))
  const always = (p.always ?? []).filter((a) => a !== "*")
  if (always.length) lines.push(`✅ always would allow: ${clip(always.join(", "), 300)}`)
  else if (p.always?.includes("*")) lines.push(`✅ always would allow all *${p.permission}* requests`)
  lines.push("React 👍 once · ✅ always · 👎 reject")
  return lines.join("\n")
}

function describeQuestion(q: Question, index: number, total: number) {
  const lines = [`❓ *${clip(q.header || "Question", 60)}*${total > 1 ? ` (${index + 1}/${total})` : ""}`, clip(q.question, 1500)]
  ;(q.options ?? []).slice(0, 20).forEach((o, i) => {
    lines.push(`${i + 1}. ${clip(o.label, 80)}${o.description ? ` · ${clip(o.description, 120)}` : ""}`)
  })
  const pick = q.options?.length ? (q.multiple ? "Reply with numbers (e.g. 1,3)" : "Reply with a number") : ""
  const typed = q.custom === false ? "" : q.options?.length ? ", or type your own answer" : "Type your answer"
  lines.push(`${pick}${typed}. /skip dismisses.`)
  return lines.join("\n")
}

/** "2" or "1, 3" picks options by number; anything else is a typed answer (when allowed). */
function parseAnswer(q: Question, text: string): string[] | string {
  const options = q.options ?? []
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  if (options.length && tokens.length && tokens.every((t) => /^\d+$/.test(t))) {
    const picks = [...new Set(tokens.map(Number))]
    if (picks.every((n) => n >= 1 && n <= options.length)) {
      if (!q.multiple && picks.length > 1) return "Pick one number."
      return picks.map((n) => options[n - 1].label)
    }
  }
  if (q.custom === false) return `Pick a number from 1 to ${options.length}.`
  return [text]
}

/** V2 form -> questions, when every visible field is a string or multiselect (the question tool's shape). */
function formQuestions(form: any): { questions: Question[]; fields: any[] } | undefined {
  const fields: any[] = (form?.fields ?? []).filter((f: any) => !f?.hidden)
  if (!fields.length || !fields.every((f) => f?.key && (f.type === "string" || f.type === "multiselect"))) return undefined
  const questions = fields.map((f) => ({
    header: f.title,
    question: f.description || f.title || form.title || "Question",
    options: (f.options ?? []).map((o: any) => ({ label: String(o.label ?? o.value), description: o.description })),
    multiple: f.type === "multiselect",
    custom: f.type === "multiselect" ? f.custom === true : f.custom !== false || !f.options?.length,
  }))
  return { questions, fields }
}

/** Answers (option labels or typed text) -> a form answer keyed by field key, using option values. */
function formAnswer(fields: any[], answers: string[][]) {
  const out: Record<string, string | string[]> = {}
  fields.forEach((f, i) => {
    const values = (answers[i] ?? []).map((a) => f.options?.find((o: any) => o.label === a)?.value ?? a)
    if (f.type === "multiselect") out[f.key] = values
    else if (values.length) out[f.key] = values[0]
  })
  return out
}

const tilde = (dir: string) => (dir.startsWith(homedir() + "/") ? "~" + dir.slice(homedir().length) : dir)

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** V2 times may arrive as epoch millis, Date, ISO string, or an Effect DateTime ({ epochMillis }). */
function millis(v: unknown): number {
  if (typeof v === "number") return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === "string") return Date.parse(v) || 0
  if (v && typeof v === "object" && typeof (v as any).epochMillis === "number") return (v as any).epochMillis
  return 0
}

function envModel() {
  const parts = process.env.WHATSAPP_AGENT_MODEL?.split("/")
  return parts && parts.length >= 2 ? { providerID: parts[0], modelID: parts.slice(1).join("/") } : undefined
}

function resolveBaseUrl(raw: string | undefined) {
  const url = new URL(raw ?? DEFAULT_BASE_URL)
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  // The API key goes in every request, so only https (or a local test server) is allowed.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`refusing non-https WhatsApp base URL: ${url.origin}`)
  }
  return url.toString().replace(/\/$/, "")
}

function readKey(opts: Options) {
  if (opts.apiKey) return opts.apiKey
  if (process.env.WHATSAPP_AGENT_API_KEY) return process.env.WHATSAPP_AGENT_API_KEY.trim()
  const file = process.env.WHATSAPP_AGENT_API_KEY_FILE ?? join(homedir(), ".config/opencode/whatsapp-agent.key")
  if (!existsSync(file)) return undefined
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  return readFileSync(file, "utf8").trim() || undefined
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

/** One poller per API key across processes: a newer poll replaces an older one (HTTP 409). */
function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 })
      return true
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      const pid = Number(readFileSync(path, "utf8").trim())
      if (pid === process.pid) return true
      if (pid && alive(pid)) return false
      unlinkSync(path) // stale lock from a dead process
    }
  }
  return false
}

// ---------------------------------------------------------------- opencode adapters

/** V1 (opencode 1.18.29+): the SDK client handed to `server(input)`. */
function hostV1(client: any): Host {
  const ref = (s: any): SessionRef | undefined =>
    s?.id
      ? { id: s.id, title: s.title, parentID: s.parentID, updated: s.time?.updated ?? 0, directory: s.directory }
      : undefined
  return {
    multiProject: false,
    log(level, message, extra) {
      // Never log message text or the API key.
      void client.app?.log?.({ body: { service: "whatsapp-agent", level, message, extra } })?.catch?.(() => {})
    },
    async getSession(id) {
      return ref((await client.session.get({ path: { id } }))?.data)
    },
    async createSession(title) {
      return ref((await client.session.create({ body: { title } }))?.data)
    },
    async listSessions() {
      return ((await client.session.list())?.data ?? []).map(ref).filter(Boolean) as SessionRef[]
    },
    async prompt(sessionID, text, picked) {
      const body: any = { parts: [{ type: "text", text }] }
      if (process.env.WHATSAPP_AGENT_AGENT) body.agent = process.env.WHATSAPP_AGENT_AGENT
      const model = picked ?? envModel()
      if (model) body.model = { providerID: model.providerID, modelID: model.modelID }
      const res = await client.session.promptAsync({ path: { id: sessionID }, body })
      return res?.error ? clip(JSON.stringify(res.error), 300) : undefined
    },
    async listModels() {
      const providers: any[] = (await client.config.providers())?.data?.providers ?? []
      return providers.flatMap((p) =>
        Object.values(p.models ?? {}).map((m: any) => ({ providerID: p.id, modelID: m.id, name: m.name })),
      )
    },
    async defaultModel() {
      const configured = (await client.config.get())?.data?.model
      const [providerID, ...rest] = typeof configured === "string" ? configured.split("/") : []
      return providerID && rest.length ? { providerID, modelID: rest.join("/") } : undefined
    },
    async sessionModel(sessionID) {
      // V1 sessions carry no model; the latest assistant message records the one used.
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 10 } })
      const last = (res?.data ?? [])
        .filter((x: any) => x?.info?.role === "assistant" && x.info.providerID && x.info.modelID)
        .sort((a: any, b: any) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
        .at(-1)
      return last ? { providerID: last.info.providerID, modelID: last.info.modelID } : undefined
    },
    async setModel() {
      return undefined // V1 has no switch call; the bridge sends the picked model with each prompt
    },
    async abort(sessionID) {
      await client.session.abort({ path: { id: sessionID } })
    },
    async finalReply(sessionID, since) {
      const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 30 } })
      const last = (res?.data ?? [])
        .filter((x: any) => x?.info?.role === "assistant" && (x.info.time?.created ?? 0) >= since - 2000)
        .sort((a: any, b: any) => a.info.time.created - b.info.time.created)
        .at(-1)
      const text = (last?.parts ?? [])
        .filter((p: any) => p?.type === "text" && !p.synthetic && !p.ignored && p.text?.trim())
        .map((p: any) => p.text.trim())
        .join("\n\n")
      const err = last?.info?.error
      return { text, error: err ? `${err.name ?? "error"}: ${clip(String(err.data?.message ?? ""), 500)}` : undefined }
    },
    async reply(req, reply) {
      const res = await client.postSessionIdPermissionsPermissionId({
        path: { id: req.sessionID, permissionID: req.id },
        body: { response: reply },
      })
      return !res?.error
    },
  }
}

/**
 * V2 (opencode 2.x): opencode runs one plugin instance per project ("location"). Every instance registers its
 * context here; the process has one bridge. Session calls use any live context (the session service is
 * global), while permission and form replies go through the context of the project that raised them.
 */
class V2Registry {
  readonly contexts = new Map<string, ContextV2>()
  bridge?: Bridge
  private listener?: { directory: string; controller: AbortController }

  add(ctx: ContextV2) {
    this.contexts.set(ctx.location.directory, ctx)
    if (this.bridge && !this.bridge.stopped && !this.listener) this.listen()
  }

  /** Called on dispose (also when idle projects are unloaded). The bridge stops with the last project. */
  remove(ctx: ContextV2) {
    const directory = ctx.location.directory
    if (this.contexts.get(directory) === ctx) this.contexts.delete(directory)
    if (this.listener?.directory === directory) {
      this.listener.controller.abort()
      this.listener = undefined
    }
    if (!this.contexts.size) {
      if (this.bridge) stopBridge(this.bridge)
      this.bridge = undefined
    } else if (this.bridge && !this.bridge.stopped && !this.listener) this.listen()
  }

  any(): any {
    const ctx = this.contexts.values().next().value
    if (!ctx) throw new Error("no opencode project is loaded")
    return ctx
  }

  at(directory: string | undefined): any {
    return (directory && this.contexts.get(directory)) || this.any()
  }

  /** One subscription is enough: the event bus is server-wide. */
  listen() {
    const bridge = this.bridge
    if (!bridge || !this.contexts.size) return
    const ctx = this.any() as ContextV2
    this.listener?.controller.abort()
    const controller = new AbortController()
    this.listener = { directory: ctx.location.directory, controller }
    const types = bridge.opts.questionGuard ? V2_EVENTS : [...V2_EVENTS, ...V2_FORM_EVENTS]
    void (async () => {
      try {
        const stream = (ctx.event as any).subscribe({ types, signal: controller.signal })
        for await (const event of stream as AsyncIterable<any>) {
          if (controller.signal.aborted) break
          try {
            await this.onEvent(bridge, event)
          } catch (err) {
            bridge.log("error", `event ${event?.type} failed`, { error: String(err) })
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) bridge.log("error", "event stream ended", { error: String(err) })
      }
    })()
  }

  private async onEvent(bridge: Bridge, event: any) {
    const d = event?.data ?? {}
    const directory: string | undefined = event?.location?.directory
    switch (event?.type) {
      case "permission.asked":
        return bridge.onPermissionAsked({
          id: d.id,
          sessionID: d.sessionID,
          permission: d.action,
          patterns: d.resources,
          always: d.save,
          metadata: d.metadata,
          directory,
        })
      case "permission.replied":
        return bridge.onPermissionReplied(d.requestID)
      case "session.execution.succeeded":
        return bridge.onIdle(d.sessionID)
      case "session.execution.failed":
        return bridge.onIdle(d.sessionID, `${d.error?.type ?? "error"}: ${clip(String(d.error?.message ?? ""), 500)}`)
      case "session.execution.interrupted":
        return bridge.onIdle(d.sessionID, `interrupted (${d.reason ?? "unknown"})`)
      case "form.created":
        return this.onForm(bridge, d.form, directory)
      case "form.replied":
      case "form.cancelled":
        return bridge.onQuestionDone(d.id)
    }
  }

  /** Dormant while QUESTION_GUARD is on, and until opencode exposes ctx.session.form to plugins. */
  private async onForm(bridge: Bridge, form: any, directory: string | undefined) {
    if (bridge.opts.questionGuard) return
    // "global" is MCP elicitation's sentinel, not a session; leave those to the TUI.
    if (!form?.id || !form.sessionID || form.sessionID === "global") return
    const ctx = this.at(directory)
    const api = ctx.session?.form
    if (!api?.reply) return
    const parsed = formQuestions(form)
    if (!parsed) return
    const { sessionID, id: formID } = form
    await bridge.askQuestion({
      id: formID,
      sessionID,
      questions: parsed.questions,
      answer: async (answers) => {
        try {
          await api.reply({ sessionID, formID, answer: formAnswer(parsed.fields, answers) })
          return true
        } catch {
          return false
        }
      },
      dismiss: async () => {
        try {
          await api.cancel({ sessionID, formID })
          return true
        } catch {
          return false
        }
      },
    })
  }
}

function hostV2(reg: V2Registry, guard: boolean): Host {
  const ref = (s: any): SessionRef | undefined =>
    s?.id
      ? {
          id: s.id,
          title: s.title,
          parentID: s.parentID,
          updated: millis(s.time?.updated),
          directory: s.location?.directory,
        }
      : undefined
  return {
    multiProject: true,
    log(level, message, extra) {
      if (level === "debug") return
      const line = `[whatsapp-agent] ${message}${extra ? " " + JSON.stringify(extra) : ""}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    },
    async getSession(id) {
      try {
        return ref(await reg.any().session.get({ sessionID: id }))
      } catch {
        return undefined
      }
    },
    async createSession(title, directory) {
      const input: any = { title }
      if (directory) input.location = { directory }
      if (process.env.WHATSAPP_AGENT_AGENT) input.agent = process.env.WHATSAPP_AGENT_AGENT
      const model = envModel()
      if (model) input.model = { providerID: model.providerID, id: model.modelID }
      if (guard) input.permissions = [DENY_QUESTION]
      return ref(await reg.any().session.create(input))
    },
    denyQuestions: guard
      ? async (sessionID) => {
          try {
            const c = reg.any()
            const rules: any[] = (await c.session.get({ sessionID }))?.permissions ?? []
            if (isDenyQuestion(rules.at(-1))) return undefined
            await c.session.update({ sessionID, permissions: [...rules, DENY_QUESTION] })
            return undefined
          } catch (e) {
            return String(e)
          }
        }
      : undefined,
    allowQuestions: guard
      ? async (sessionID) => {
          try {
            const c = reg.any()
            const rules: any[] = (await c.session.get({ sessionID }))?.permissions ?? []
            const i = rules.findLastIndex(isDenyQuestion)
            if (i < 0) return undefined
            await c.session.update({ sessionID, permissions: rules.filter((_, j) => j !== i) })
            return undefined
          } catch (e) {
            return String(e)
          }
        }
      : undefined,
    async listSessions() {
      const page = await reg.any().session.list({ limit: 30 })
      return (page?.data ?? []).map(ref).filter(Boolean) as SessionRef[]
    },
    async prompt(sessionID, text) {
      try {
        await reg.any().session.prompt({ sessionID, text })
        return undefined
      } catch (e) {
        return clip(String(e), 300)
      }
    },
    async listModels(directory) {
      const res = await reg.at(directory).model.list({ types: ["chat"] })
      return ((res?.data ?? []) as any[])
        .filter((m) => m?.enabled !== false && (!m.type || m.type === "chat"))
        .map((m) => ({ providerID: m.providerID, modelID: m.id, name: m.name }))
    },
    async defaultModel(directory) {
      const m = (await reg.at(directory).model.default())?.data
      return m ? { providerID: m.providerID, modelID: m.id, name: m.name } : undefined
    },
    async sessionModel(sessionID) {
      try {
        const m = (await reg.any().session.get({ sessionID }))?.model
        return m ? { providerID: m.providerID, modelID: m.id } : undefined
      } catch {
        return undefined
      }
    },
    async setModel(sessionID, model) {
      try {
        await reg.any().session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.modelID } })
        return undefined
      } catch (e) {
        return clip(String(e), 300)
      }
    },
    async abort(sessionID) {
      await reg.any().session.interrupt({ sessionID })
    },
    async finalReply(sessionID, since) {
      const messages: any[] = (await reg.any().session.context({ sessionID })) ?? []
      const last = messages
        .filter((m) => m?.type === "assistant" && millis(m.time?.created) >= since - 2000)
        .sort((a, b) => millis(a.time.created) - millis(b.time.created))
        .at(-1)
      const text = (last?.content ?? [])
        .filter((p: any) => p?.type === "text" && p.text?.trim())
        .map((p: any) => p.text.trim())
        .join("\n\n")
      const err = last?.error
      return { text, error: err ? `${err.type ?? "error"}: ${clip(String(err.message ?? ""), 500)}` : undefined }
    },
    async reply(req, reply) {
      try {
        // Pending permissions live in the raising project's permission service.
        await reg.at(req.directory).permission.reply({ sessionID: req.sessionID, requestID: req.id, decision: reply })
        return true
      } catch {
        return false
      }
    },
  }
}

// ---------------------------------------------------------------- WhatsApp client

class WhatsApp {
  private chain: Promise<unknown> = Promise.resolve()
  private lastSend = 0
  private lastStatus = 0

  constructor(
    private key: string,
    private base: string,
    private interval: number,
    private log: (level: Level, msg: string, extra?: object) => void,
  ) {}

  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const res = await fetch(this.base + path, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const raw = res.status === 204 ? "" : await res.text()
    let json: any
    try {
      json = raw ? JSON.parse(raw) : undefined
    } catch {
      json = undefined
    }
    return { status: res.status, json, retryAfter: Number(res.headers.get("retry-after")) || 0 }
  }

  poll(offset: number | undefined, timeout: number, signal: AbortSignal) {
    const q = new URLSearchParams({ limit: "50", timeout: String(timeout) })
    if (offset !== undefined) q.set("offset", String(offset))
    return this.call("GET", `/updates?${q}`, undefined, signal)
  }

  /** Mark read (optionally with typing). 403 means the sender is not the agent's creator. */
  async markRead(messageId: string, typing = false, wait = true) {
    const gap = this.lastStatus + this.interval - Date.now()
    if (gap > 0) {
      if (!wait) return 0
      await sleep(gap)
    }
    this.lastStatus = Date.now()
    const body: any = { messaging_product: "whatsapp", status: "read", message_id: messageId }
    if (typing) body.typing_indicator = { type: "text" }
    try {
      return (await this.call("POST", "/statuses", body)).status
    } catch {
      return 0
    }
  }

  /** Serialized, paced send. Resolves to the wamid, or undefined if it was not sent. */
  send(to: string, text: string, quote?: string): Promise<string | undefined> {
    const job = this.chain.then(() => this.sendNow(to, text, quote))
    this.chain = job.catch(() => undefined)
    return job
  }

  private async sendNow(to: string, text: string, quote?: string) {
    const body: any = { messaging_product: "whatsapp", to, type: "text", text: { body: clip(text, MAX_TEXT) } }
    if (quote) body.context = { message_id: quote }
    for (let attempt = 0; attempt < 4; attempt++) {
      const gap = this.lastSend + this.interval - Date.now()
      if (gap > 0) await sleep(gap)
      this.lastSend = Date.now()
      let res
      try {
        res = await this.call("POST", "/messages", body)
      } catch (e) {
        // Connection reset / timeout: unknown whether it was sent; don't risk a duplicate.
        this.log("warn", "send failed (network); not retrying", { error: String(e) })
        return undefined
      }
      if (res.status >= 200 && res.status < 300) return res.json?.messages?.[0]?.id as string | undefined
      if (res.status === 429 || res.status === 503) {
        await sleep(Math.max(res.retryAfter * 1000, this.interval * 2 ** attempt))
        continue
      }
      if (res.status === 400 && quote) {
        delete body.context // quoted message no longer valid: send unquoted
        quote = undefined
        continue
      }
      this.log("warn", "send rejected", { status: res.status, code: res.json?.error?.code })
      return undefined
    }
    return undefined
  }
}

// ---------------------------------------------------------------- bridge

class Bridge {
  private abort = new AbortController()
  private state: State
  private seen = new Set<string>()
  private pendingByWamid = new Map<string, PermissionRequest>()
  private wamidByRequest = new Map<string, string>()
  private questionsById = new Map<string, QuestionState>()
  private questionsByWamid = new Map<string, QuestionState>()
  private awaiting = new Map<string, { since: number; wamid: string }>()
  private typing = new Map<string, ReturnType<typeof setInterval>>()
  private lastList: string[] = []
  private lastProjects: string[] = []
  private lastModels: ModelRef[] = []
  private rootCache = new Map<string, string>()
  private wa: WhatsApp
  private statePath: string
  private lockPath: string
  stopped = false

  constructor(
    private host: Host,
    private directory: string,
    readonly opts: BridgeOpts,
    key: string,
    baseUrl: string,
    stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.statePath = join(stateDir, "state.json")
    this.lockPath = join(stateDir, "poll.lock")
    this.state = this.load()
    this.wa = new WhatsApp(key, baseUrl, opts.sendIntervalMs, (l, m, x) => this.log(l, m, x))
  }

  log(level: Level, message: string, extra?: object) {
    this.host.log(level, message, extra)
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8"))
      return { sessions: {}, models: {}, ...s }
    } catch {
      return { sessions: {}, models: {} }
    }
  }

  private save() {
    const tmp = this.statePath + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.statePath)
  }

  start(): boolean {
    if (!acquireLock(this.lockPath)) {
      this.log("info", "another opencode process owns the WhatsApp poller; this one stays idle")
      return false
    }
    process.once("exit", () => this.releaseLock())
    void this.run()
    return true
  }

  private releaseLock() {
    try {
      if (Number(readFileSync(this.lockPath, "utf8").trim()) === process.pid) unlinkSync(this.lockPath)
    } catch {}
  }

  stop() {
    this.stopped = true
    this.abort.abort()
    this.questionsById.clear()
    this.questionsByWamid.clear()
    for (const t of this.typing.values()) clearInterval(t)
    this.typing.clear()
    this.releaseLock()
  }

  // ------------------------------------------------------------ polling

  private async run() {
    let backoff = 0
    this.log("info", "polling WhatsApp Agent Platform", { directory: this.directory })
    while (!this.stopped) {
      const started = Date.now()
      let res
      try {
        res = await this.wa.poll(this.state.offset, this.opts.pollTimeoutSec, this.abort.signal)
      } catch (e) {
        if (this.stopped) break
        backoff = Math.min(Math.max(backoff * 2, 2000), 60000)
        this.log("warn", "poll failed; backing off", { ms: backoff, error: String(e) })
        await sleep(backoff, this.abort.signal)
        continue
      }
      if (res.status === 200) {
        backoff = 0
        await this.handleUpdates(res.json)
      } else if (res.status === 204) {
        backoff = 0 // nothing new; re-poll with the same offset
      } else if (res.status === 409) {
        this.log("warn", "another poller replaced this one (409); stopping")
        break
      } else if (res.status === 401 || (res.status === 400 && res.json?.error?.code === 100)) {
        this.log("error", "WhatsApp API key rejected; regenerate it in Chat info > API key")
        break
      } else {
        backoff = Math.min(Math.max(backoff * 2, res.retryAfter * 1000, 2000), 60000)
        this.log("warn", "poll error; backing off", { status: res.status, ms: backoff })
        await sleep(backoff, this.abort.signal)
      }
      const elapsed = Date.now() - started
      if (elapsed < this.opts.pollFloorMs) await sleep(this.opts.pollFloorMs - elapsed, this.abort.signal)
    }
    this.stop()
  }

  private async handleUpdates(json: any) {
    for (const entry of json?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const m of change?.value?.messages ?? []) {
          if (!m?.id || this.seen.has(m.id)) continue
          this.seen.add(m.id)
          if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!)
          try {
            await this.handleMessage(m as WaMessage)
          } catch (e) {
            this.log("error", "failed to handle message", { error: String(e) })
          }
        }
      }
    }
    if (typeof json?.next_offset === "number") {
      this.state.offset = json.next_offset
      this.save()
    }
  }

  /** The platform only lets the creator message the agent; a read receipt confirms it (403 otherwise). */
  private async verifySender(m: WaMessage, typing: boolean) {
    const status = await this.wa.markRead(m.id, typing)
    if (status === 200) {
      if (this.state.creator !== m.from) {
        this.state.creator = m.from
        this.save()
      }
      return true
    }
    if (status === 403) this.log("warn", "dropped message from a sender that is not the agent's creator")
    else if (m.from === this.state.creator) return true // receipt failed transiently; sender already verified
    else this.log("warn", "could not verify sender; message dropped", { status })
    return false
  }

  private async handleMessage(m: WaMessage) {
    if (m.type === "reaction") {
      if (m.from !== this.state.creator || !m.reaction?.message_id || !m.reaction.emoji) return
      const req = this.pendingByWamid.get(m.reaction.message_id)
      const reply = reactionToReply(m.reaction.emoji)
      if (req && reply) await this.answer(req, reply)
      return
    }
    const text = m.type === "text" ? (m.text?.body ?? "").trim() : ""
    const isCommand = text.startsWith("/")
    // Plain text goes to: the message it quotes; else a bare y/a/n for a pending permission;
    // else the pending question; else a new prompt. Commands always run.
    const quotedPermission = m.context?.id ? this.pendingByWamid.get(m.context.id) : undefined
    const quotedQuestion = m.context?.id ? this.questionsByWamid.get(m.context.id) : undefined
    const reply = text && !quotedQuestion ? textToReply(text) : undefined
    const approval = reply && (quotedPermission || this.pendingByWamid.size > 0) ? reply : undefined
    const question = text && !isCommand && !approval && !quotedPermission ? (quotedQuestion ?? this.latestQuestion()) : undefined
    const isPrompt = !!text && !approval && !question && !isCommand

    // The read receipt doubles as the typing indicator for prompts (statuses are rate limited).
    if (!(await this.verifySender(m, isPrompt))) return
    if (m.type !== "text") return void (await this.say("Only text messages are supported for now.", m.id))
    if (!text) return
    if (approval) return this.answer(quotedPermission ?? [...this.pendingByWamid.values()].at(-1)!, approval)
    if (question) return this.answerQuestion(question, text, m)
    if (isCommand) return this.command(text, m)
    await this.prompt(text, m)
  }

  private say(text: string, quote?: string) {
    if (!this.state.creator) return Promise.resolve(undefined)
    return this.wa.send(this.state.creator, text, quote)
  }

  // ------------------------------------------------------------ sessions

  /** V2 tracks one current session across projects; V1 one per project. */
  private get key() {
    return this.host.multiProject ? "*" : this.directory
  }

  private current(): string | undefined {
    return this.state.sessions[this.key] ?? (this.host.multiProject ? this.state.sessions[this.directory] : undefined)
  }

  private setCurrent(id: string | undefined) {
    if (id) this.state.sessions[this.key] = id
    else delete this.state.sessions[this.key]
    this.save()
  }

  /** Where new sessions go: /cd's pick (V2), else the project the bridge started in. */
  private cwd() {
    return (this.host.multiProject && this.state.cwd) || this.directory
  }

  /**
   * Switches the current session: the one left behind gets the question tool back (TUI forms work there
   * again), the new one has it turned off. Resolves to an error description for the new session, or undefined.
   */
  private async switchSession(id: string | undefined) {
    const prev = this.current()
    this.setCurrent(id)
    if (prev && prev !== id) {
      await this.leave(prev)
      const err = await this.host.allowQuestions?.(prev)
      if (err) this.log("warn", "could not restore the question tool", { sessionID: prev, error: err })
    }
    return id ? this.host.denyQuestions?.(id) : undefined
  }

  /** True for the current session and its subagents: the only ones WhatsApp sees (unless forward=all). */
  private async isCurrent(sessionID: string) {
    const cur = this.current()
    return !!cur && (sessionID === cur || (await this.root(sessionID)) === cur)
  }

  /** Stops following a session we switched away from: no reply, no typing, its prompts stay in the TUI. */
  private async leave(sessionID: string) {
    this.awaiting.delete(sessionID)
    this.stopTyping(sessionID)
    if (this.opts.forward === "all") return
    for (const [wamid, req] of [...this.pendingByWamid]) {
      if ((await this.root(req.sessionID)) !== sessionID) continue
      this.pendingByWamid.delete(wamid)
      this.wamidByRequest.delete(req.id)
    }
    for (const state of [...this.questionsById.values()]) {
      if ((await this.root(state.req.sessionID)) === sessionID) this.dropQuestion(state.req.id)
    }
  }

  private async ensureSession() {
    const id = this.current()
    if (id && (await this.host.getSession(id))) return id
    const created = await this.host.createSession("WhatsApp", this.cwd())
    if (!created) throw new Error("could not create session")
    this.setCurrent(created.id)
    return created.id
  }

  private async prompt(text: string, m: WaMessage) {
    let sessionID: string
    try {
      sessionID = await this.ensureSession()
    } catch (e) {
      await this.say(`⚠️ ${String(e)}`, m.id)
      return
    }
    if (!this.awaiting.has(sessionID)) this.awaiting.set(sessionID, { since: Date.now(), wamid: m.id })
    const error = await this.host.prompt(sessionID, text, this.state.models[sessionID])
    if (error) {
      this.awaiting.delete(sessionID)
      await this.say(`⚠️ opencode rejected the prompt: ${error}`, m.id)
      return
    }
    this.startTyping(sessionID, m.id, false) // verifySender already showed the indicator
  }

  private startTyping(sessionID: string, wamid: string, now = true) {
    this.stopTyping(sessionID)
    if (now) void this.wa.markRead(wamid, true, false)
    // The indicator lasts 25s; refresh while waiting, but not over a pending permission prompt.
    const t = setInterval(() => {
      if (!this.awaiting.has(sessionID)) return this.stopTyping(sessionID)
      if (this.pendingByWamid.size || this.questionsById.size) return // waiting on you, not the model
      void this.wa.markRead(wamid, true, false)
    }, 22000)
    this.typing.set(sessionID, t)
  }

  private stopTyping(sessionID: string) {
    const t = this.typing.get(sessionID)
    if (t) clearInterval(t)
    this.typing.delete(sessionID)
  }

  /** Root session id (walks parentID so subagent permissions map to the WhatsApp session). */
  private async root(sessionID: string) {
    let id = sessionID
    for (let i = 0; i < 8; i++) {
      const cached = this.rootCache.get(id)
      if (cached) return cached
      const parent = (await this.host.getSession(id))?.parentID
      if (!parent) break
      id = parent
    }
    this.rootCache.set(sessionID, id)
    return id
  }

  /** A turn ended. `hint` describes a failure/interruption reported by the event itself (V2). */
  async onIdle(sessionID: string | undefined, hint?: string) {
    if (!sessionID) return
    const wait = this.awaiting.get(sessionID)
    if (!wait) return
    this.awaiting.delete(sessionID)
    this.stopTyping(sessionID)
    const reply = await this.host.finalReply(sessionID, wait.since)
    let text = reply.text
    const err = reply.error ?? hint
    if (err) text = `${text ? text + "\n\n" : ""}⚠️ ${err}`
    if (!text) text = "✅ Done (no text reply)."
    await this.sendLong(text, wait.wamid)
  }

  /** Markdown -> WhatsApp, split under the size cap, at most MAX_CHUNKS messages; the first quotes `quote`. */
  private async sendLong(text: string, quote?: string) {
    let parts = chunk(toWhatsApp(text))
    if (parts.length > MAX_CHUNKS) {
      parts = parts.slice(0, MAX_CHUNKS)
      parts[MAX_CHUNKS - 1] += "\n\n… reply truncated; see the terminal for the rest."
    }
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n(${i + 1}/${parts.length})` : ""
      await this.say(parts[i] + suffix, i === 0 ? quote : undefined)
    }
  }

  // ------------------------------------------------------------ permissions

  async onPermissionAsked(p: PermissionRequest) {
    if (!p?.id || !p.sessionID || !this.state.creator || this.wamidByRequest.has(p.id)) return
    if (this.opts.forward === "whatsapp" && !(await this.isCurrent(p.sessionID))) return
    this.wamidByRequest.set(p.id, "") // reserve: avoid a duplicate send while this one is in flight
    const wamid = await this.say(describePermission(p))
    if (!wamid) {
      this.wamidByRequest.delete(p.id)
      return
    }
    if (!this.wamidByRequest.has(p.id)) return // answered in the terminal while sending
    this.wamidByRequest.set(p.id, wamid)
    this.pendingByWamid.set(wamid, p)
  }

  onPermissionReplied(requestID: string | undefined) {
    if (!requestID) return
    const wamid = this.wamidByRequest.get(requestID)
    this.wamidByRequest.delete(requestID)
    if (wamid) this.pendingByWamid.delete(wamid)
  }

  private async answer(req: PermissionRequest, reply: Reply) {
    const wamid = this.wamidByRequest.get(req.id)
    if (wamid) this.pendingByWamid.delete(wamid)
    this.wamidByRequest.delete(req.id)
    if (!(await this.host.reply(req, reply))) {
      await this.say("That request was already answered or has expired.", wamid || undefined)
      return
    }
    const root = await this.root(req.sessionID)
    const wait = this.awaiting.get(root)
    if (reply !== "reject" && wait) this.startTyping(root, wait.wamid)
  }

  // ------------------------------------------------------------ questions

  private latestQuestion() {
    return [...this.questionsById.values()].at(-1)
  }

  private dropQuestion(id: string) {
    const state = this.questionsById.get(id)
    this.questionsById.delete(id)
    if (state?.wamid) this.questionsByWamid.delete(state.wamid)
    return state
  }

  /**
   * Forwards a question, following WHATSAPP_AGENT_FORWARD like permissions.
   * Resolves to true when the question was sent to WhatsApp.
   */
  async askQuestion(req: QuestionRequest): Promise<boolean> {
    if (this.stopped || !req?.id || !req.sessionID || !req.questions?.length || !this.state.creator) return false
    if (this.questionsById.has(req.id)) return true
    if (this.opts.forward === "whatsapp" && !(await this.isCurrent(req.sessionID))) return false
    const state: QuestionState = { req, index: 0, answers: [] }
    this.questionsById.set(req.id, state)
    const wamid = await this.say(describeQuestion(req.questions[0], 0, req.questions.length))
    if (!wamid) {
      this.questionsById.delete(req.id)
      return false
    }
    if (!this.questionsById.has(req.id)) return true // answered in the terminal while sending
    state.wamid = wamid
    this.questionsByWamid.set(wamid, state)
    return true
  }

  /** Answered, rejected or cancelled in the TUI. */
  onQuestionDone(id: string | undefined) {
    if (id) this.dropQuestion(id)
  }

  private async answerQuestion(state: QuestionState, text: string, m: WaMessage) {
    const q = state.req.questions[state.index]
    const parsed = parseAnswer(q, text)
    if (typeof parsed === "string") return void (await this.say(parsed, m.id))
    state.answers[state.index] = parsed
    state.index++
    if (state.index < state.req.questions.length) {
      if (state.wamid) this.questionsByWamid.delete(state.wamid)
      const wamid = await this.say(describeQuestion(state.req.questions[state.index], state.index, state.req.questions.length))
      if (wamid && this.questionsById.has(state.req.id)) {
        state.wamid = wamid
        this.questionsByWamid.set(wamid, state)
      }
      return
    }
    this.dropQuestion(state.req.id)
    if (!(await state.req.answer(state.answers))) {
      return void (await this.say("That question was already answered or has expired.", m.id))
    }
    const root = await this.root(state.req.sessionID)
    const wait = this.awaiting.get(root)
    if (wait) this.startTyping(root, wait.wamid)
  }

  // ------------------------------------------------------------ models

  /** What the session runs on: /model pick, else the session's own model, else the env/default. */
  private async effectiveModel(sessionID: string | undefined) {
    const picked = sessionID ? this.state.models[sessionID] : undefined
    if (picked) return { model: picked, source: "picked with /model" }
    const own = sessionID ? await this.host.sessionModel(sessionID).catch(() => undefined) : undefined
    if (own) return { model: own, source: "session" }
    const env = envModel()
    if (env) return { model: env, source: "WHATSAPP_AGENT_MODEL" }
    const def = await this.host.defaultModel(this.cwd()).catch(() => undefined)
    return def ? { model: def, source: "opencode default" } : undefined
  }

  private async models(filter: string, m: WaMessage) {
    let all: ModelRef[]
    try {
      all = (await this.host.listModels(this.cwd())).sort((a, b) => modelKey(a).localeCompare(modelKey(b)))
    } catch (e) {
      return void (await this.say(`⚠️ Could not list models: ${clip(String(e), 200)}`, m.id))
    }
    const f = filter.toLowerCase()
    const list = f ? all.filter((x) => `${modelKey(x)} ${x.name ?? ""}`.toLowerCase().includes(f)) : all
    if (!list.length) return void (await this.say(f ? `No models match "${filter}".` : "No models configured.", m.id))
    const shown = list.slice(0, 30)
    this.lastModels = shown
    const current = await this.effectiveModel(this.current())
    const def = await this.host.defaultModel(this.cwd()).catch(() => undefined)
    const lines = shown.map((x, i) => {
      const mark = current && modelKey(current.model) === modelKey(x) ? "▶️ " : ""
      const star = def && modelKey(def) === modelKey(x) ? " ⭐" : ""
      return `${i + 1}. ${mark}${modelKey(x)}${x.name && x.name !== x.modelID ? ` · ${clip(x.name, 40)}` : ""}${star}`
    })
    const more = list.length > shown.length ? `\n… ${list.length - shown.length} more; narrow it with /models <text>` : ""
    await this.say(`Models (▶️ current · ⭐ default):\n${lines.join("\n")}${more}\n\nSwitch with /model <n>`, m.id)
  }

  private async model(arg: string, m: WaMessage) {
    if (!arg) {
      const cur = await this.effectiveModel(this.current())
      return void (await this.say(cur ? `🧠 ${modelKey(cur.model)} (${cur.source})` : "🧠 No model resolved yet.", m.id))
    }
    const n = Number(arg)
    let pick: ModelRef | undefined
    if (Number.isInteger(n) && n >= 1) pick = this.lastModels[n - 1]
    else {
      const all = await this.host.listModels(this.cwd()).catch(() => [] as ModelRef[])
      pick = all.find((x) => modelKey(x).toLowerCase() === arg.toLowerCase())
    }
    if (!pick) return void (await this.say("Unknown model. Run /models and pick a number, or use provider/model.", m.id))
    let sessionID: string
    try {
      sessionID = await this.ensureSession()
    } catch (e) {
      return void (await this.say(`⚠️ ${String(e)}`, m.id))
    }
    const error = await this.host.setModel(sessionID, pick)
    if (error) return void (await this.say(`⚠️ Could not switch: ${error}`, m.id))
    const { name, ...ref } = pick
    this.state.models[sessionID] = ref
    const keys = Object.keys(this.state.models)
    if (keys.length > 50) delete this.state.models[keys[0]]
    this.save()
    await this.say(`🧠 Now using ${modelKey(pick)}${name && name !== pick.modelID ? ` · ${name}` : ""}`, m.id)
  }

  // ------------------------------------------------------------ projects

  /** "/cd" lists projects (from recent sessions); "/cd <n>" or "/cd <absolute path>" picks one for new sessions. */
  private async cd(arg: string, m: WaMessage) {
    if (!this.host.multiProject) return void (await this.say(`This opencode version stays in ${this.directory}.`, m.id))
    if (!arg) {
      const recent = (await this.host.listSessions().catch(() => [] as SessionRef[]))
        .sort((a, b) => b.updated - a.updated)
        .map((s) => s.directory)
      this.lastProjects = [...new Set([this.cwd(), this.directory, ...recent].filter(Boolean) as string[])].slice(0, 10)
      const lines = this.lastProjects.map((d, i) => `${i + 1}. ${d === this.cwd() ? "▶️ " : ""}${tilde(d)}`)
      return void (await this.say(`Projects:\n${lines.join("\n")}\n\nPick with /cd <n> or /cd <path>`, m.id))
    }
    const n = Number(arg)
    let dir = Number.isInteger(n) && n >= 1 ? this.lastProjects[n - 1] : undefined
    if (!dir) {
      const path = arg === "~" ? homedir() : arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg
      if (!isAbsolute(path)) return void (await this.say("Use /cd <n> from the list, or an absolute path.", m.id))
      dir = resolve(path)
      let ok = false
      try {
        ok = statSync(dir).isDirectory()
      } catch {}
      if (!ok) return void (await this.say(`Not a folder: ${tilde(dir)}`, m.id))
    }
    this.state.cwd = dir
    await this.switchSession(undefined) // the next message starts a session there
    await this.say(`📁 ${tilde(dir)}\nYour next message starts a new session here (or /use one).`, m.id)
  }

  // ------------------------------------------------------------ commands

  private async command(text: string, m: WaMessage) {
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(" ").trim()
    switch (cmd.toLowerCase()) {
      case "/new": {
        const created = await this.host.createSession(arg || "WhatsApp", this.cwd())
        if (!created) return void (await this.say("⚠️ Could not create a session.", m.id))
        await this.switchSession(created.id)
        const where = this.host.multiProject ? ` in ${tilde(created.directory ?? this.cwd())}` : ""
        return void (await this.say(`🆕 New session: *${created.title || arg || "WhatsApp"}*${where}`, m.id))
      }
      case "/sessions": {
        const list = (await this.host.listSessions())
          .filter((s) => !s.parentID)
          .sort((a, b) => b.updated - a.updated)
          .slice(0, this.host.multiProject ? 12 : 8)
        this.lastList = list.map((s) => s.id)
        if (!list.length) return void (await this.say("No sessions yet. Send a message to start one.", m.id))
        const cur = this.current()
        const lines = list.map(
          (s, i) =>
            `${i + 1}. ${s.id === cur ? "▶️ " : ""}${clip(s.title || "untitled", 50)}` +
            `${this.host.multiProject && s.directory ? ` · ${clip(tilde(s.directory), 40)}` : ""} · ${ago(s.updated)}`,
        )
        const head = this.host.multiProject ? "Recent sessions:" : `Sessions in ${this.directory}:`
        return void (await this.say(`${head}\n${lines.join("\n")}\n\nSwitch with /use <n>`, m.id))
      }
      case "/cd":
        return this.cd(arg, m)
      case "/use": {
        const n = Number(arg)
        const id = Number.isInteger(n) && n >= 1 ? this.lastList[n - 1] : arg.startsWith("ses") ? arg : undefined
        const got = id ? await this.host.getSession(id) : undefined
        if (!got) return void (await this.say("Unknown session. Run /sessions first.", m.id))
        const err = await this.switchSession(got.id)
        const note = err ? `\n⚠️ Couldn't turn off the question tool: ${clip(err, 200)}` : ""
        const where = this.host.multiProject && got.directory ? ` · ${tilde(got.directory)}` : ""
        await this.say(`▶️ Now chatting in *${got.title || "untitled"}*${where}${note}`, m.id)
        // Where you left off: the session's last assistant reply.
        const last = await this.host.finalReply(got.id, 0).catch(() => undefined)
        if (last?.text) await this.sendLong(`💬 Last reply:\n\n${last.text}`)
        return
      }
      case "/skip": {
        const state = this.latestQuestion()
        if (!state) return void (await this.say("No question is waiting.", m.id))
        this.dropQuestion(state.req.id)
        const ok = await state.req.dismiss()
        return void (await this.say(ok ? "⏭️ Skipped." : "That question was already answered or has expired.", m.id))
      }
      case "/models":
        return this.models(arg, m)
      case "/model":
        return this.model(arg, m)
      case "/stop": {
        const id = this.current()
        if (!id) return void (await this.say("No active session.", m.id))
        await this.host.abort(id)
        return void (await this.say("⏹️ Stopped.", m.id))
      }
      case "/status": {
        const id = this.current()
        const got = id ? await this.host.getSession(id) : undefined
        const model = await this.effectiveModel(got ? id : undefined)
        const folder = got?.directory ?? this.cwd()
        return void (await this.say(
          [
            `📁 ${tilde(folder)}${this.host.multiProject && folder !== this.cwd() ? ` · /new goes to ${tilde(this.cwd())}` : ""}`,
            `💬 ${got?.title ? `*${got.title}*` : got ? "untitled session" : "no session yet"}`,
            `🧠 ${model ? `${modelKey(model.model)} (${model.source})` : "model not resolved"}`,
            `🔐 ${this.pendingByWamid.size} pending approval(s) · ❓ ${this.questionsById.size} question(s) · forwarding: ${this.opts.forward}`,
          ].join("\n"),
          m.id,
        ))
      }
      default:
        return void (await this.say(
          [
            "*opencode over WhatsApp*",
            "Any text → prompt the current session",
            "/new [title] · new session",
            "/sessions · list recent sessions",
            "/use <n> · switch session",
            ...(this.host.multiProject ? ["/cd [n | path] · pick the project for new sessions"] : []),
            "/models [text] · list models (filter by text)",
            "/model [n | provider/model] · show or switch this session's model",
            "/stop · abort the running turn",
            "/status · directory, session, approvals",
            "",
            "Approvals: react 👍 once · ✅ always · 👎 reject (or reply y / a / n)",
            "Questions: reply with a number (1,3 for several) or your own answer · /skip dismisses",
          ].join("\n"),
          m.id,
        ))
    }
  }
}

// ---------------------------------------------------------------- plugin entrypoints

/** Starts the process-wide bridge, or returns undefined when inert or another instance owns it. */
function startBridge(host: Host, directory: string, raw: unknown) {
  const opts = (raw ?? {}) as Options
  const key = readKey(opts)
  if (!key) return undefined
  const g = globalThis as any
  // One bridge per process: opencode creates a plugin instance per project location.
  if (g[GLOBAL_KEY] && !g[GLOBAL_KEY].stopped) return undefined
  const bridge = new Bridge(
    host,
    directory,
    {
      forward: (opts.forward ?? process.env.WHATSAPP_AGENT_FORWARD) === "all" ? "all" : "whatsapp",
      sendIntervalMs: opts.sendIntervalMs ?? 5100,
      pollFloorMs: opts.pollFloorMs ?? 4100,
      pollTimeoutSec: Math.min(Math.max(opts.pollTimeoutSec ?? 25, 0), 25),
      questionGuard: opts.questionGuard ?? QUESTION_GUARD,
    },
    key,
    resolveBaseUrl(opts.baseUrl ?? process.env.WHATSAPP_AGENT_BASE_URL),
    opts.stateDir ?? process.env.WHATSAPP_AGENT_STATE_DIR ?? join(homedir(), ".local/state/opencode-whatsapp-agent"),
  )
  if (!bridge.start()) return undefined
  g[GLOBAL_KEY] = bridge
  return bridge
}

function stopBridge(bridge: Bridge) {
  bridge.stop()
  const g = globalThis as any
  if (g[GLOBAL_KEY] === bridge) delete g[GLOBAL_KEY]
}

/** V1 entrypoint (opencode 1.18.29+). */
const server: PluginV1 = async (input, options) => {
  const bridge = startBridge(hostV1(input.client), input.directory, options)
  if (!bridge) return {}
  // The V1 SDK has no question methods; its underlying request client already carries the
  // server URL, directory and auth, so post to the question routes directly.
  const raw = (input.client as any)._client
  const questionPost = async (action: "reply" | "reject", requestID: string, body?: unknown) => {
    if (!raw?.post) return false
    const res = await raw.post({
      url: `/question/{requestID}/${action}`,
      path: { requestID },
      ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
    })
    return !res?.error
  }
  return {
    event: async ({ event }) => {
      const e = event as unknown as { type: string; properties: any }
      try {
        if (e.type === "permission.asked") await bridge.onPermissionAsked(e.properties)
        else if (e.type === "permission.replied")
          bridge.onPermissionReplied(e.properties?.requestID ?? e.properties?.permissionID)
        else if (e.type === "session.idle") await bridge.onIdle(e.properties?.sessionID)
        else if (e.type === "question.asked") {
          const p = e.properties ?? {}
          await bridge.askQuestion({
            id: p.id,
            sessionID: p.sessionID,
            questions: p.questions ?? [],
            answer: (answers) => questionPost("reply", p.id, { answers }),
            dismiss: () => questionPost("reject", p.id),
          })
        } else if (e.type === "question.replied" || e.type === "question.rejected")
          bridge.onQuestionDone(e.properties?.requestID)
      } catch (err) {
        bridge.log("error", `event ${e.type} failed`, { error: String(err) })
      }
    },
    dispose: async () => stopBridge(bridge),
  }
}

const V2_EVENTS = [
  "permission.asked",
  "permission.replied",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]
const V2_FORM_EVENTS = ["form.created", "form.replied", "form.cancelled"]

/** V2 entrypoint (opencode 2.x): runs once per project the server loads. */
async function setup(ctx: ContextV2) {
  const g = globalThis as any
  const reg: V2Registry = (g[REGISTRY_KEY] ??= new V2Registry())
  reg.add(ctx)
  if (!reg.bridge || reg.bridge.stopped) {
    const guard = (ctx.options as Options | undefined)?.questionGuard ?? QUESTION_GUARD
    reg.bridge = startBridge(hostV2(reg, guard), ctx.location.directory, ctx.options)
    reg.listen()
  }
  return () => reg.remove(ctx)
}

// V2 calls setup(ctx); V1 calls server(input). Same shape as @opencode/plugin's Plugin.define({ id, setup }).
export default { id: "whatsapp-agent", setup, server } satisfies PluginV2.Plugin & { server: PluginV1 }
