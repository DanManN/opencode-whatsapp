// End-to-end tests: a mock WhatsApp Agent Platform server (shapes from the v1 developer manual)
// and a fake opencode V1 client that records calls.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

const CREATOR = "user:111"
const STRANGER = "user:999"

type Sent = { to: string; text: string; quote?: string; wamid: string }

function mockWhatsApp() {
  const queue: any[] = []
  const sent: Sent[] = []
  const statuses: { message_id: string; typing: boolean }[] = []
  const authors = new Map<string, string>() // inbound wamid -> from
  let offset = 0
  let wamidSeq = 0
  let polls = 0
  let respond409 = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer test-key") return Response.json({ error: { code: 190 } }, { status: 401 })
      if (url.pathname === "/agent/v1/updates") {
        polls++
        if (respond409) return Response.json({ error: { code: 1752041 } }, { status: 409 })
        for (let i = 0; i < 20 && queue.length === 0; i++) await Bun.sleep(5) // short long-poll
        const pending = queue.splice(0)
        if (!pending.length) return new Response(null, { status: 204 })
        offset += pending.length
        return Response.json({
          object: "whatsapp_agent_platform",
          entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts: [], messages: pending, statuses: [] } }] }],
          next_offset: offset,
        })
      }
      if (url.pathname === "/agent/v1/statuses") {
        const body: any = await req.json()
        statuses.push({ message_id: body.message_id, typing: !!body.typing_indicator })
        if (authors.get(body.message_id) !== CREATOR) return Response.json({ error: { code: 131005 } }, { status: 403 })
        return Response.json({ success: true })
      }
      if (url.pathname === "/agent/v1/messages") {
        const body: any = await req.json()
        if (body.to !== CREATOR) return Response.json({ error: { code: 131005 } }, { status: 403 })
        if (body.text.body.length > 4096) return Response.json({ error: { code: 100 } }, { status: 400 })
        const wamid = `wamid.out${++wamidSeq}`
        sent.push({ to: body.to, text: body.text.body, quote: body.context?.message_id, wamid })
        return Response.json({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: wamid }] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  let inSeq = 0
  return {
    url: `http://127.0.0.1:${server.port}/agent/v1`,
    sent,
    statuses,
    polls: () => polls,
    set409: (v: boolean) => (respond409 = v),
    text(body: string, from = CREATOR, context?: { id: string }) {
      const id = `wamid.in${++inSeq}`
      authors.set(id, from)
      queue.push({ from, id, timestamp: "1", type: "text", text: { body }, ...(context ? { context: { ...context, from: "agent:1" } } : {}) })
      return id
    },
    react(messageId: string, emoji: string, from = CREATOR) {
      const id = `wamid.in${++inSeq}`
      authors.set(id, from)
      queue.push({ from, id, timestamp: "1", type: "reaction", reaction: { message_id: messageId, emoji } })
      return id
    },
    stop: () => server.stop(true),
  }
}

function fakeClient() {
  const sessions = new Map<string, any>()
  const messages = new Map<string, any[]>()
  const calls: { method: string; args: any }[] = []
  let seq = 0
  const rec = (method: string, args: any) => calls.push({ method, args })
  const client: any = {
    app: { log: async () => ({}) },
    _client: {
      post: async (args: any) => {
        rec("raw.post", args)
        return args.path?.requestID === "que_gone" ? { error: { name: "NotFound" } } : { data: true }
      },
    },
    config: {
      get: async () => ({ data: { model: "rapid-mlx/qwen3.5-4b-4bit" } }),
      providers: async () => ({
        data: {
          providers: [
            { id: "rapid-mlx", name: "rapid-mlx", models: { "qwen3.5-4b-4bit": { id: "qwen3.5-4b-4bit", name: "Qwen 3.5 4B" } } },
            { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X" } } },
          ],
          default: {},
        },
      }),
    },
    session: {
      create: async (args: any) => {
        rec("session.create", args)
        const s = { id: `ses_${++seq}`, title: args?.body?.title ?? "untitled", parentID: args?.body?.parentID, time: { created: Date.now(), updated: Date.now() + seq } }
        sessions.set(s.id, s)
        return { data: s }
      },
      get: async (args: any) => {
        const s = sessions.get(args.path.id)
        return s ? { data: s } : { error: { name: "NotFound" } }
      },
      list: async () => ({ data: [...sessions.values()] }),
      promptAsync: async (args: any) => {
        rec("session.promptAsync", args)
        return { data: undefined }
      },
      messages: async (args: any) => ({ data: messages.get(args.path.id) ?? [] }),
      abort: async (args: any) => {
        rec("session.abort", args)
        return { data: true }
      },
    },
    postSessionIdPermissionsPermissionId: async (args: any) => {
      rec("permission.reply", args)
      return args.path.permissionID === "per_gone" ? { error: { name: "NotFound" } } : { data: true }
    },
  }
  return {
    client,
    calls,
    sessions,
    addSession: (s: any) => sessions.set(s.id, { time: { created: 0, updated: 0 }, ...s }),
    assistantReply(sessionID: string, parts: any[], error?: any) {
      const list = messages.get(sessionID) ?? []
      list.push({ info: { role: "assistant", time: { created: Date.now() }, ...(error ? { error } : {}) }, parts })
      messages.set(sessionID, list)
    },
  }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

let wa: ReturnType<typeof mockWhatsApp>
let oc: ReturnType<typeof fakeClient>
let hooks: any
let stateDir: string

async function boot(extra: Record<string, unknown> = {}) {
  hooks = await plugin.server(
    { client: oc.client, directory: "/proj", worktree: "/proj" } as any,
    { apiKey: "test-key", baseUrl: wa.url, stateDir, sendIntervalMs: 1, pollFloorMs: 1, pollTimeoutSec: 0, ...extra },
  )
  return hooks
}

beforeEach(() => {
  wa = mockWhatsApp()
  oc = fakeClient()
  stateDir = mkdtempSync(join(tmpdir(), "wa-agent-test-"))
})

afterEach(async () => {
  await hooks?.dispose?.()
  hooks = undefined
  wa.stop()
  rmSync(stateDir, { recursive: true, force: true })
})

const emit = (type: string, properties: any) => hooks.event({ event: { type, properties } })

test("drops messages from anyone but the agent's creator", async () => {
  await boot()
  wa.text("hello", STRANGER)
  await until(() => wa.statuses.length === 1)
  await Bun.sleep(50)
  expect(oc.calls.filter((c) => c.method === "session.promptAsync")).toHaveLength(0)
  expect(wa.sent).toHaveLength(0)
})

test("text prompts the session and the idle reply comes back formatted", async () => {
  await boot()
  const inbound = wa.text("what is in this repo?")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const prompt = oc.calls.find((c) => c.method === "session.promptAsync")!
  expect(prompt.args.body.parts).toEqual([{ type: "text", text: "what is in this repo?" }])
  expect(wa.statuses[0]).toEqual({ message_id: inbound, typing: true })

  const sessionID = prompt.args.path.id
  oc.assistantReply(sessionID, [
    { type: "text", text: "## Summary\n**Two** files, see [docs](https://example.com)." },
    { type: "text", text: "internal", synthetic: true },
  ])
  await emit("session.idle", { sessionID })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toBe("*Summary*\n*Two* files, see docs (https://example.com).")
  expect(wa.sent[0].quote).toBe(inbound)
})

test("permission prompt is forwarded and each reaction maps to a reply", async () => {
  await boot()
  wa.text("run the tests")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const sessionID = oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id

  const cases: [string, string][] = [["👍", "once"], ["✅", "always"], ["👎🏽", "reject"]]
  for (const [i, [emoji, reply]] of cases.entries()) {
    const id = `per_${i}`
    await emit("permission.asked", { id, sessionID, permission: "bash", patterns: ["bun test"], always: ["bun test *"], metadata: { command: "bun test" } })
    await until(() => wa.sent.length === i + 1)
    const msg = wa.sent[i]
    expect(msg.text).toContain("🔐 *bash* permission")
    expect(msg.text).toContain("```bun test```")
    expect(msg.text).toContain("bun test *")
    wa.react(msg.wamid, emoji)
    await until(() => oc.calls.filter((c) => c.method === "permission.reply").length === i + 1)
    const call = oc.calls.filter((c) => c.method === "permission.reply")[i]
    expect(call.args).toEqual({ path: { id: sessionID, permissionID: id }, body: { response: reply } })
  }
})

test("bare text answers the pending permission; reactions to other messages are ignored", async () => {
  await boot()
  wa.text("deploy")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const sessionID = oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id
  await emit("permission.asked", { id: "per_x", sessionID, permission: "edit", patterns: ["src/a.ts"], always: ["*"], metadata: { filepath: "src/a.ts", diff: "-a\n+b" } })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("always would allow all *edit* requests")
  wa.react("wamid.unrelated", "👍")
  wa.text("n")
  await until(() => oc.calls.some((c) => c.method === "permission.reply"))
  const replies = oc.calls.filter((c) => c.method === "permission.reply")
  expect(replies).toHaveLength(1)
  expect(replies[0].args.body.response).toBe("reject")
  expect(oc.calls.filter((c) => c.method === "session.promptAsync")).toHaveLength(1) // "n" was not sent as a prompt
})

test("subagent permissions are forwarded; unrelated sessions are not (default mode)", async () => {
  await boot()
  wa.text("hi")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const root = oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id
  oc.addSession({ id: "ses_child", parentID: root })
  oc.addSession({ id: "ses_tui" })
  await emit("permission.asked", { id: "per_tui", sessionID: "ses_tui", permission: "bash", patterns: ["ls"], metadata: { command: "ls" } })
  await emit("permission.asked", { id: "per_child", sessionID: "ses_child", permission: "bash", patterns: ["pwd"], metadata: { command: "pwd" } })
  await until(() => wa.sent.length === 1)
  await Bun.sleep(50)
  expect(wa.sent).toHaveLength(1)
  expect(wa.sent[0].text).toContain("```pwd```")
})

test("forward=all forwards terminal sessions too; replied-in-terminal requests are dropped", async () => {
  await boot({ forward: "all" })
  wa.text("/help")
  await until(() => wa.sent.length === 1)
  oc.addSession({ id: "ses_tui" })
  await emit("permission.asked", { id: "per_tui", sessionID: "ses_tui", permission: "webfetch", patterns: ["https://x.dev"], metadata: { url: "https://x.dev" } })
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toContain("https://x.dev")
  await emit("permission.replied", { sessionID: "ses_tui", requestID: "per_tui", reply: "once" })
  wa.react(wa.sent[1].wamid, "👍")
  await Bun.sleep(100)
  expect(oc.calls.filter((c) => c.method === "permission.reply")).toHaveLength(0)
})

test("stale approval gets a friendly note", async () => {
  await boot({ forward: "all" })
  wa.text("/status")
  await until(() => wa.sent.length === 1)
  oc.addSession({ id: "ses_tui" })
  await emit("permission.asked", { id: "per_gone", sessionID: "ses_tui", permission: "bash", patterns: ["x"], metadata: { command: "x" } })
  await until(() => wa.sent.length === 2)
  wa.react(wa.sent[1].wamid, "👍")
  await until(() => wa.sent.length === 3)
  expect(wa.sent[2].text).toContain("already answered")
})

test("/sessions, /use, /new and /stop", async () => {
  oc.addSession({ id: "ses_a", title: "Refactor", time: { created: 1, updated: Date.now() - 60_000 } })
  oc.addSession({ id: "ses_b", title: "Docs", time: { created: 1, updated: Date.now() } })
  oc.addSession({ id: "ses_kid", title: "subagent", parentID: "ses_a", time: { created: 1, updated: Date.now() } })
  await boot()
  wa.text("/sessions")
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toMatch(/1\. Docs[\s\S]*2\. Refactor/)
  expect(wa.sent[0].text).not.toContain("subagent")
  wa.text("/use 2")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toContain("*Refactor*")
  wa.text("continue")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  expect(oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id).toBe("ses_a")
  wa.text("/stop")
  await until(() => oc.calls.some((c) => c.method === "session.abort"))
  expect(oc.calls.find((c) => c.method === "session.abort")!.args.path.id).toBe("ses_a")
  wa.text("/new Bugfix")
  await until(() => wa.sent.some((s) => s.text.includes("New session")))
  expect(oc.calls.filter((c) => c.method === "session.create").at(-1)!.args.body.title).toBe("Bugfix")
})

test("v1: /models lists and marks the default; /model <n> is sent with later prompts", async () => {
  await boot()
  wa.text("/models")
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("1. anthropic/claude-x · Claude X")
  expect(wa.sent[0].text).toContain("2. ▶️ rapid-mlx/qwen3.5-4b-4bit · Qwen 3.5 4B ⭐")
  wa.text("/model 1")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toBe("🧠 Now using anthropic/claude-x · Claude X")
  wa.text("hello")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  expect(oc.calls.find((c) => c.method === "session.promptAsync")!.args.body.model).toEqual({ providerID: "anthropic", modelID: "claude-x" })
  wa.text("/model")
  await until(() => wa.sent.length === 3)
  expect(wa.sent[2].text).toBe("🧠 anthropic/claude-x (picked with /model)")
  wa.text("/model nope/none")
  await until(() => wa.sent.length === 4)
  expect(wa.sent[3].text).toContain("Unknown model")
})

test("v1: /status shows the opencode default model when nothing is picked", async () => {
  await boot()
  wa.text("/status")
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("🧠 rapid-mlx/qwen3.5-4b-4bit (opencode default)")
})

const DB_Q = {
  header: "Database",
  question: "Which database should I use?",
  options: [
    { label: "Postgres", description: "Full SQL server" },
    { label: "SQLite", description: "Single file" },
  ],
}
const FEATURES_Q = {
  header: "Features",
  question: "Which features?",
  multiple: true,
  options: [{ label: "Auth", description: "" }, { label: "Billing", description: "" }, { label: "Search", description: "" }],
}

async function v1DrivenSession() {
  await boot()
  wa.text("set it up")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  return oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id as string
}

test("v1 question: options forwarded, numbered reply posts the labels; multi-select and typed answers", async () => {
  const sessionID = await v1DrivenSession()
  await emit("question.asked", { id: "que_1", sessionID, questions: [DB_Q, FEATURES_Q] })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("❓ *Database* (1/2)")
  expect(wa.sent[0].text).toContain("1. Postgres · Full SQL server")
  expect(wa.sent[0].text).toContain("Reply with a number, or type your own answer")
  wa.text("2")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toContain("❓ *Features* (2/2)")
  expect(wa.sent[1].text).toContain("Reply with numbers (e.g. 1,3)")
  wa.text("1, 3")
  await until(() => oc.calls.some((c) => c.method === "raw.post"))
  const post = oc.calls.find((c) => c.method === "raw.post")!.args
  expect(post.url).toBe("/question/{requestID}/reply")
  expect(post.path).toEqual({ requestID: "que_1" })
  expect(post.body).toEqual({ answers: [["SQLite"], ["Auth", "Search"]] })
  expect(oc.calls.filter((c) => c.method === "session.promptAsync")).toHaveLength(1) // answers were not prompts
})

test("v1 question: typed answer, two numbers on single choice, /skip rejects", async () => {
  const sessionID = await v1DrivenSession()
  await emit("question.asked", { id: "que_2", sessionID, questions: [DB_Q] })
  await until(() => wa.sent.length === 1)
  wa.text("1 2")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toBe("Pick one number.")
  wa.text("MySQL please")
  await until(() => oc.calls.some((c) => c.method === "raw.post"))
  expect(oc.calls.find((c) => c.method === "raw.post")!.args.body).toEqual({ answers: [["MySQL please"]] })
  await emit("question.asked", { id: "que_3", sessionID, questions: [{ ...DB_Q, custom: false }] })
  await until(() => wa.sent.length === 3)
  wa.text("whatever")
  await until(() => wa.sent.length === 4)
  expect(wa.sent[3].text).toBe("Pick a number from 1 to 2.")
  wa.text("/skip")
  await until(() => oc.calls.filter((c) => c.method === "raw.post").length === 2)
  const reject = oc.calls.filter((c) => c.method === "raw.post")[1].args
  expect(reject.url).toBe("/question/{requestID}/reject")
  expect(reject.path).toEqual({ requestID: "que_3" })
})

test("v1 question: answered in the TUI, so the next text is a prompt again", async () => {
  const sessionID = await v1DrivenSession()
  await emit("question.asked", { id: "que_4", sessionID, questions: [DB_Q] })
  await until(() => wa.sent.length === 1)
  await emit("question.replied", { sessionID, requestID: "que_4", answers: [["Postgres"]] })
  wa.text("thanks, keep going")
  await until(() => oc.calls.filter((c) => c.method === "session.promptAsync").length === 2)
  expect(oc.calls.filter((c) => c.method === "raw.post")).toHaveLength(0)
})

test("long replies are chunked under the 4096 cap", async () => {
  await boot()
  wa.text("write a lot")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const sessionID = oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id
  const para = "x".repeat(1000)
  oc.assistantReply(sessionID, [{ type: "text", text: Array(9).fill(para).join("\n\n") }])
  await emit("session.idle", { sessionID })
  await until(() => wa.sent.length === 3)
  for (const s of wa.sent) expect(s.text.length).toBeLessThanOrEqual(4096)
  expect(wa.sent[0].text.endsWith("(1/3)")).toBe(true)
  expect(wa.sent[2].text.endsWith("(3/3)")).toBe(true)
})

test("assistant errors are reported", async () => {
  await boot()
  wa.text("go")
  await until(() => oc.calls.some((c) => c.method === "session.promptAsync"))
  const sessionID = oc.calls.find((c) => c.method === "session.promptAsync")!.args.path.id
  oc.assistantReply(sessionID, [], { name: "ProviderAuthError", data: { message: "bad key" } })
  await emit("session.idle", { sessionID })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toBe("⚠️ ProviderAuthError: bad key")
})

test("only one poller: second instance in-process and a live foreign lock both stay idle", async () => {
  await boot()
  const second = await plugin.server({ client: oc.client, directory: "/other", worktree: "/other" } as any, { apiKey: "test-key", baseUrl: wa.url, stateDir })
  expect(second).toEqual({})
  await hooks.dispose()
  hooks = undefined
  writeFileSync(join(stateDir, "poll.lock"), String(process.ppid)) // parent process is alive
  const before = wa.polls()
  const third = await plugin.server({ client: oc.client, directory: "/proj", worktree: "/proj" } as any, { apiKey: "test-key", baseUrl: wa.url, stateDir, pollFloorMs: 1, pollTimeoutSec: 0 })
  expect(third).toEqual({})
  await Bun.sleep(100)
  expect(wa.polls()).toBe(before)
})

test("stops polling when another poller replaces it (409)", async () => {
  wa.set409(true)
  await boot()
  await until(() => wa.polls() >= 1)
  await Bun.sleep(100)
  expect(wa.polls()).toBe(1)
})

// ---------------------------------------------------------------- V2 (opencode 2.x: setup(ctx))

/**
 * Fake V2 server: one session store and event stream shared by every project context (opencode runs one
 * plugin instance per project). Calls record `via`, the project whose context made them.
 */
function fakeV2(options: Record<string, unknown>, opts: { forms?: boolean } = {}) {
  const sessions = new Map<string, any>()
  const context = new Map<string, any[]>()
  const calls: { method: string; args: any }[] = []
  const queue: any[] = []
  let wake: (() => void) | undefined
  let seq = 0
  const rec = (method: string, args: any) => calls.push({ method, args })

  const project = (directory: string): any => {
    const via = { via: directory }
    return {
      location: { directory, project: { id: `prj_${directory}`, directory, canonical: directory } },
      options,
      session: {
        create: async (input: any) => {
          rec("session.create", { ...input, ...via })
          const s = {
            id: `ses_v2_${++seq}`,
            title: input?.title,
            permissions: input?.permissions,
            location: { directory: input?.location?.directory ?? directory },
            time: { created: Date.now(), updated: Date.now() + seq },
          }
          sessions.set(s.id, s)
          return s
        },
        get: async ({ sessionID }: any) => {
          const s = sessions.get(sessionID)
          if (!s) throw new Error("Session.NotFound")
          return s
        },
        list: async (input: any) => {
          rec("session.list", input)
          return { data: [...sessions.values()], cursor: {} }
        },
        prompt: async (input: any) => {
          rec("session.prompt", input)
          return { id: "inb_1" }
        },
        interrupt: async (input: any) => {
          rec("session.interrupt", input)
          return { interrupted: true }
        },
        context: async ({ sessionID }: any) => context.get(sessionID) ?? [],
        switchModel: async (input: any) => {
          rec("session.switchModel", input)
          const s = sessions.get(input.sessionID)
          if (s) s.model = input.model
        },
        update: async (input: any) => {
          rec("session.update", input)
          const s = sessions.get(input.sessionID)
          if (s && input.permissions) s.permissions = input.permissions
        },
        // anomalyco/opencode#59655 shape; only present when the test opts in.
        ...(opts.forms
          ? {
              form: {
                reply: async (input: any) => {
                  rec("form.reply", { ...input, ...via })
                  if (input.formID === "frm_gone") throw new Error("Form.NotFound")
                },
                cancel: async (input: any) => rec("form.cancel", { ...input, ...via }),
              },
            }
          : {}),
      },
      model: {
        list: async (input: any) => {
          rec("model.list", { ...input, ...via })
          return {
            data: [
              { id: "big-pickle", providerID: "opencode", name: "Big Pickle", type: "chat", enabled: true },
              { id: "gpt-img", providerID: "openai", name: "Image", type: "image", enabled: true },
              { id: "old", providerID: "openai", name: "Old", type: "chat", enabled: false },
              { id: "qwen", providerID: "rapid-mlx", name: "Qwen", enabled: true },
            ],
          }
        },
        default: async () => ({ data: { id: "qwen", providerID: "rapid-mlx", name: "Qwen" } }),
      },
      permission: {
        reply: async (input: any) => {
          rec("permission.reply", { ...input, ...via })
          if (input.requestID === "per_gone") throw new Error("Permission.NotFound")
        },
      },
      tool: {
        transform: async () => rec("tool.transform", via),
      },
      event: {
        subscribe: ({ types, signal }: { types: string[]; signal: AbortSignal }) => {
          rec("event.subscribe", { types, ...via })
          return {
            async *[Symbol.asyncIterator]() {
              while (!signal.aborted) {
                if (queue.length) yield queue.shift()
                else
                  await new Promise<void>((r) => ((wake = r), signal.addEventListener("abort", () => r(), { once: true })))
              }
            },
          }
        },
      },
    }
  }

  return {
    ctx: project("/proj"),
    project,
    calls,
    sessions,
    emit(type: string, data: any, location = { directory: "/proj" }) {
      queue.push({ id: "evt_1", created: Date.now(), type, location, data })
      wake?.()
    },
    assistant(sessionID: string, content: any[], error?: any) {
      const list = context.get(sessionID) ?? []
      list.push({ type: "assistant", content, time: { created: Date.now() }, ...(error ? { error } : {}) })
      context.set(sessionID, list)
    },
  }
}

/** Boots the "/proj" instance; `more` adds instances for other projects. All are disposed after the test. */
async function bootV2(extra: Record<string, unknown> = {}, opts: { forms?: boolean; more?: string[] } = {}) {
  const v2 = fakeV2({ apiKey: "test-key", baseUrl: wa.url, stateDir, sendIntervalMs: 1, pollFloorMs: 1, pollTimeoutSec: 0, ...extra }, opts)
  const cleanups: any[] = [await plugin.setup(v2.ctx)]
  const others = new Map<string, any>()
  for (const dir of opts.more ?? []) {
    const ctx = v2.project(dir)
    others.set(dir, ctx)
    cleanups.push(await plugin.setup(ctx))
  }
  hooks = { dispose: async () => cleanups.reverse().forEach((c) => c?.()) } // afterEach runs these
  return { ...v2, others, cleanups }
}

test("v2: prompt, execution.succeeded, and the final assistant text comes back", async () => {
  const v2 = await bootV2()
  const inbound = wa.text("summarize")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const prompt = v2.calls.find((c) => c.method === "session.prompt")!.args
  expect(prompt.text).toBe("summarize")
  v2.assistant(prompt.sessionID, [{ type: "reasoning", text: "hmm" }, { type: "text", text: "**All good**" }])
  v2.emit("session.execution.succeeded", { sessionID: prompt.sessionID })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toBe("*All good*")
  expect(wa.sent[0].quote).toBe(inbound)
})

test("v2: shell permission (action/resources/save) forwarded; ✅ replies with decision always", async () => {
  const v2 = await bootV2()
  wa.text("check git")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const sessionID = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  v2.emit("permission.asked", { id: "per_v2", sessionID, action: "shell", resources: ["git status"], save: ["git status *"] })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("🔐 *shell* permission")
  expect(wa.sent[0].text).toContain("```git status```")
  expect(wa.sent[0].text).toContain("git status *")
  wa.react(wa.sent[0].wamid, "✅")
  await until(() => v2.calls.some((c) => c.method === "permission.reply"))
  expect(v2.calls.find((c) => c.method === "permission.reply")!.args).toEqual({ sessionID, requestID: "per_v2", decision: "always", via: "/proj" })
})

test("v2: failed execution reports the event's error; forward=all covers other projects, replied through theirs", async () => {
  const v2 = await bootV2({ forward: "all" }, { more: ["/elsewhere"] })
  wa.text("go")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const sessionID = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  v2.emit("session.execution.failed", { sessionID, error: { type: "ProviderError", message: "rate limited" } })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toBe("⚠️ ProviderError: rate limited")
  v2.emit("permission.asked", { id: "per_other", sessionID: "ses_x", action: "edit", resources: ["a.ts"] }, { directory: "/elsewhere" })
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toContain("a.ts")
  wa.react(wa.sent[1].wamid, "👍")
  await until(() => v2.calls.some((c) => c.method === "permission.reply"))
  expect(v2.calls.find((c) => c.method === "permission.reply")!.args).toEqual({
    sessionID: "ses_x",
    requestID: "per_other",
    decision: "once",
    via: "/elsewhere",
  })
})

test("v2: one bridge for all projects; the event stream moves when its project unloads", async () => {
  const v2 = await bootV2({}, { more: ["/elsewhere"] })
  const subs = () => v2.calls.filter((c) => c.method === "event.subscribe")
  expect(subs()).toHaveLength(1)
  expect(subs()[0].args.via).toBe("/proj")
  expect(v2.calls.some((c) => c.method === "tool.transform")).toBe(false) // no question wrapper
  expect(subs()[0].args.types).not.toContain("form.created") // forms stay off while the guard is on
  v2.cleanups[0]() // "/proj" unloaded
  v2.cleanups[0] = undefined
  await until(() => subs().length === 2)
  expect(subs()[1].args.via).toBe("/elsewhere")
  wa.text("/help")
  await until(() => wa.sent.length === 1) // still polling
  expect(wa.sent[0].text).toContain("/cd")
})

test("v2: /sessions spans projects; /cd picks where /new goes; /stop interrupts; stale reply handled", async () => {
  const v2 = await bootV2({ forward: "all" })
  v2.sessions.set("ses_far", { id: "ses_far", title: "Far", location: { directory: "/far" }, time: { updated: 1 } })
  wa.text("/new Work")
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toBe("🆕 New session: *Work* in /proj")
  wa.text("/sessions")
  await until(() => wa.sent.length === 2)
  expect(v2.calls.find((c) => c.method === "session.list")!.args).toEqual({ limit: 30 })
  expect(wa.sent[1].text).toContain("1. ▶️ Work · /proj")
  expect(wa.sent[1].text).toContain("2. Far · /far")
  wa.text("/cd")
  await until(() => wa.sent.length === 3)
  expect(wa.sent[2].text).toContain("1. ▶️ /proj")
  expect(wa.sent[2].text).toContain("2. /far")
  wa.text("/cd 2")
  await until(() => wa.sent.length === 4)
  expect(wa.sent[3].text).toContain("📁 /far")
  wa.text("/cd relative/path")
  await until(() => wa.sent.length === 5)
  expect(wa.sent[4].text).toContain("absolute path")
  wa.text("/cd /definitely/not/here")
  await until(() => wa.sent.length === 6)
  expect(wa.sent[5].text).toContain("Not a folder")
  wa.text("hi there")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  expect(v2.calls.filter((c) => c.method === "session.create").at(-1)!.args.location).toEqual({ directory: "/far" })
  wa.text("/stop")
  await until(() => v2.calls.some((c) => c.method === "session.interrupt"))
  v2.emit("permission.asked", { id: "per_gone", sessionID: "ses_z", action: "shell", resources: ["rm x"] })
  await until(() => wa.sent.length === 8)
  wa.react(wa.sent[7].wamid, "👍")
  await until(() => wa.sent.length === 9)
  expect(wa.sent[8].text).toContain("already answered")
})

test("v2: WhatsApp sees one session at a time; switching drops the old session's reply and prompts", async () => {
  const v2 = await bootV2()
  wa.text("work on a")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const a = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  v2.sessions.set("ses_a_sub", { id: "ses_a_sub", parentID: a, location: { directory: "/proj" }, time: { updated: 1 } })
  v2.emit("permission.asked", { id: "per_a", sessionID: "ses_a_sub", action: "shell", resources: ["make"] })
  await until(() => wa.sent.length === 1) // subagent of the current session: forwarded
  wa.text("/new B")
  await until(() => wa.sent.length === 2)
  v2.emit("permission.asked", { id: "per_a2", sessionID: a, action: "shell", resources: ["ls"] })
  v2.assistant(a, [{ type: "text", text: "a is done" }])
  v2.emit("session.execution.succeeded", { sessionID: a })
  await Bun.sleep(60)
  expect(wa.sent).toHaveLength(2) // nothing from a after the switch
  wa.text("y") // per_a was dropped on switch, so this is a prompt to B, not an approval
  await until(() => v2.calls.filter((c) => c.method === "session.prompt").length === 2)
  expect(v2.calls.some((c) => c.method === "permission.reply")).toBe(false)
  expect(v2.calls.filter((c) => c.method === "session.prompt").at(-1)!.args.sessionID).not.toBe(a)
})

test("v2: /use reaches sessions in other projects and resends the last reply", async () => {
  const v2 = await bootV2()
  v2.sessions.set("ses_far", { id: "ses_far", title: "Far", location: { directory: "/far" }, time: { updated: 1 } })
  v2.assistant("ses_far", [{ type: "text", text: "old" }])
  v2.assistant("ses_far", [{ type: "reasoning", text: "hmm" }, { type: "text", text: "**Left off here**" }])
  wa.text("/use ses_far")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[0].text).toBe("▶️ Now chatting in *Far* · /far")
  expect(wa.sent[1].text).toBe("💬 Last reply:\n\n*Left off here*")
  wa.text("do it")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  expect(v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID).toBe("ses_far")
})

test("v2: switching sessions moves the question guard: the one left gets it back, the new one loses it", async () => {
  const v2 = await bootV2()
  const deny = { action: "question", resource: "*", effect: "deny" }
  wa.text("/new Mine")
  await until(() => wa.sent.length === 1)
  expect(v2.calls.find((c) => c.method === "session.create")!.args.permissions).toEqual([deny])
  const mine = [...v2.sessions.keys()][0]
  const allow = { action: "shell", resource: "git *", effect: "allow" }
  v2.sessions.set("ses_tui", { id: "ses_tui", title: "TUI", permissions: [allow], time: { updated: Date.now() } })
  wa.text("/use ses_tui")
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toContain("Now chatting in *TUI*")
  expect(wa.sent[1].text).not.toContain("Couldn't")
  expect(v2.sessions.get("ses_tui").permissions).toEqual([allow, deny])
  expect(v2.sessions.get(mine).permissions).toEqual([])
  wa.text("/use ses_tui") // same session: nothing to move
  await until(() => wa.sent.length === 3)
  expect(v2.calls.filter((c) => c.method === "session.update")).toHaveLength(2)
  wa.text(`/use ${mine}`)
  await until(() => wa.sent.length === 4)
  expect(v2.sessions.get("ses_tui").permissions).toEqual([allow])
  expect(v2.sessions.get(mine).permissions).toEqual([deny])
  wa.text("/cd /tmp") // no current session afterwards, so the guard is released
  await until(() => wa.sent.length === 5)
  expect(v2.sessions.get(mine).permissions).toEqual([])
})

test("v2: /models shows enabled chat models; /model provider/id calls switchModel", async () => {
  const v2 = await bootV2()
  wa.text("/models")
  await until(() => wa.sent.length === 1)
  expect(v2.calls.find((c) => c.method === "model.list")!.args).toEqual({ types: ["chat"], via: "/proj" })
  expect(wa.sent[0].text).toContain("1. opencode/big-pickle · Big Pickle")
  expect(wa.sent[0].text).toContain("2. ▶️ rapid-mlx/qwen · Qwen ⭐")
  expect(wa.sent[0].text).not.toContain("gpt-img")
  expect(wa.sent[0].text).not.toContain("openai/old")
  wa.text("/model opencode/big-pickle")
  await until(() => v2.calls.some((c) => c.method === "session.switchModel"))
  const sw = v2.calls.find((c) => c.method === "session.switchModel")!.args
  expect(sw.model).toEqual({ providerID: "opencode", id: "big-pickle" })
  await until(() => wa.sent.length === 2)
  expect(wa.sent[1].text).toBe("🧠 Now using opencode/big-pickle · Big Pickle")
  wa.text("/status")
  await until(() => wa.sent.length === 3)
  expect(wa.sent[2].text).toContain("🧠 opencode/big-pickle")
})

const formFrom = (id: string, sessionID: string, questions: any[]) => ({
  id,
  sessionID,
  title: "Questions",
  metadata: { kind: "question" },
  fields: questions.map((q, i) => ({
    key: `q${i}`,
    title: q.header,
    description: q.question,
    type: q.multiple ? "multiselect" : "string",
    options: q.options.map((o: any) => ({ value: o.label, label: o.label, description: o.description })),
    custom: true,
  })),
})

test("v2 forms (guard off): question form forwarded; reply goes through the raising project's form API", async () => {
  const v2 = await bootV2({ questionGuard: false }, { forms: true, more: ["/elsewhere"] })
  expect(v2.calls.find((c) => c.method === "event.subscribe")!.args.types).toContain("form.created")
  wa.text("set it up")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const sessionID = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  expect(v2.calls.find((c) => c.method === "session.create")!.args.permissions).toBeUndefined()
  v2.emit("form.created", { form: formFrom("frm_1", sessionID, [DB_Q, FEATURES_Q]) }, { directory: "/elsewhere" })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("❓ *Database* (1/2)")
  wa.text("2")
  await until(() => wa.sent.length === 2)
  wa.text("1,3")
  await until(() => v2.calls.some((c) => c.method === "form.reply"))
  const reply = v2.calls.find((c) => c.method === "form.reply")!.args
  expect(reply.via).toBe("/elsewhere")
  expect(reply.answer).toEqual({ q0: "SQLite", q1: [FEATURES_Q.options[0].label, FEATURES_Q.options[2].label] })
})

test("v2 forms (guard off): skips global and non-question forms; /skip cancels; replied in TUI clears it", async () => {
  const v2 = await bootV2({ questionGuard: false }, { forms: true })
  wa.text("go")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const sessionID = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  v2.emit("form.created", { form: { ...formFrom("frm_g", "global", [DB_Q]) } })
  v2.emit("form.created", { form: { id: "frm_n", sessionID, title: "N", fields: [{ key: "n", type: "number" }] } })
  v2.emit("form.created", { form: formFrom("frm_2", sessionID, [DB_Q]) })
  await until(() => wa.sent.length === 1)
  expect(wa.sent[0].text).toContain("❓ *Database*")
  wa.text("/skip")
  await until(() => v2.calls.some((c) => c.method === "form.cancel"))
  expect(v2.calls.find((c) => c.method === "form.cancel")!.args).toEqual({ sessionID, formID: "frm_2", via: "/proj" })
  await until(() => wa.sent.length === 2)
  v2.emit("form.created", { form: formFrom("frm_3", sessionID, [DB_Q]) })
  await until(() => wa.sent.length === 3)
  v2.emit("form.replied", { id: "frm_3", sessionID, answer: { q0: "Postgres" } })
  await Bun.sleep(30)
  wa.text("next message")
  await until(() => v2.calls.filter((c) => c.method === "session.prompt").length === 2) // not taken as an answer
})

test("v2 forms: dormant while the guard is on, even when ctx.session.form exists", async () => {
  const v2 = await bootV2({}, { forms: true })
  wa.text("go")
  await until(() => v2.calls.some((c) => c.method === "session.prompt"))
  const sessionID = v2.calls.find((c) => c.method === "session.prompt")!.args.sessionID
  v2.emit("form.created", { form: formFrom("frm_x", sessionID, [DB_Q]) })
  await Bun.sleep(60)
  expect(wa.sent).toHaveLength(0)
})

test("no key: plugin is inert; non-https base URL is refused", async () => {
  const saved = process.env.WHATSAPP_AGENT_API_KEY
  delete process.env.WHATSAPP_AGENT_API_KEY
  process.env.WHATSAPP_AGENT_API_KEY_FILE = join(stateDir, "missing.key")
  expect(await plugin.server({ client: oc.client, directory: "/p", worktree: "/p" } as any, {})).toEqual({})
  if (saved) process.env.WHATSAPP_AGENT_API_KEY = saved
  delete process.env.WHATSAPP_AGENT_API_KEY_FILE
  await expect(plugin.server({ client: oc.client, directory: "/p", worktree: "/p" } as any, { apiKey: "k", baseUrl: "http://evil.example/agent/v1", stateDir })).rejects.toThrow("non-https")
})
