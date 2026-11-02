import { describe, expect, test } from "bun:test"
import plugin from "./index.js"

type SetupContext = Parameters<typeof plugin.setup>[0]

function harness() {
  const store = new Map<string, unknown>()
  const commands = new Map<string, { execute: (input: unknown) => Promise<void> }>()
  const synthetic: Array<{ text?: string; description?: string }> = []
  let idle: ((event: { sessionID: string; background: unknown[] }) => Promise<void>) | undefined
  let messages: unknown[] = []

  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
    },
    command: {
      transform: async (cb: (editor: { add: (d: unknown) => void }) => void) => {
        cb({ add: (d: unknown) => commands.set((d as { name: string }).name, d as never) })
      },
    },
    session: {
      instructions: { entry: { put: async () => {}, remove: async () => {} } },
      synthetic: async (input: { text?: string; description?: string }) => {
        synthetic.push(input)
      },
      context: async () => messages,
      hook: async (name: string, cb: never) => {
        if (name === "experimental.idle") idle = cb
      },
    },
  } as unknown as SetupContext

  return {
    ctx,
    store,
    commands,
    synthetic,
    setMessages: (value: unknown[]) => {
      messages = value
    },
    idle: (event: { sessionID: string; background: unknown[] }) => {
      if (!idle) throw new Error("idle hook not registered")
      return idle(event)
    },
  }
}

describe("ralph-loop plugin", () => {
  test("registra os comandos e o hook idle", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    expect([...h.commands.keys()].sort()).toEqual(["cancel-ralph", "ralph-loop"])
  })

  test("inicia o loop com kickoff e continua até o marker", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    const start = h.commands.get("ralph-loop")
    await start!.execute({
      sessionID: "ses_1",
      prompt: { text: "fix tests --completion-promise DONE --max-iterations 2" },
      delivery: "steer",
    })
    expect(h.synthetic[0]?.text).toContain("fix tests")
    expect(h.store.get("session:ses_1")).toMatchObject({ iteration: 0, status: "active", maxIterations: 2 })

    h.setMessages([{ type: "assistant", content: [{ type: "text", text: "still working" }] }])
    await h.idle({ sessionID: "ses_1", background: [] })
    expect(h.synthetic[1]?.text).toContain("iteration 1/2")
    expect(h.store.get("session:ses_1")).toMatchObject({ iteration: 1, status: "active" })

    h.setMessages([{ type: "assistant", content: [{ type: "text", text: "done DONE" }] }])
    await h.idle({ sessionID: "ses_1", background: [] })
    expect(h.store.get("session:ses_1")).toMatchObject({ status: "done" })
    expect(h.synthetic).toHaveLength(2)
  })

  test("pausa ao atingir o limite e cancelar remove o estado", async () => {
    const h = harness()
    await plugin.setup(h.ctx)
    await h.commands.get("ralph-loop")!.execute({
      sessionID: "ses_2",
      prompt: { text: "task --max-iterations 1" },
      delivery: "steer",
    })
    h.setMessages([{ type: "assistant", content: [{ type: "text", text: "working" }] }])
    await h.idle({ sessionID: "ses_2", background: [] })
    await h.idle({ sessionID: "ses_2", background: [] })
    expect(h.store.get("session:ses_2")).toMatchObject({ status: "paused" })

    await h.commands.get("cancel-ralph")!.execute({ sessionID: "ses_2", prompt: { text: "" }, delivery: "steer" })
    expect(h.store.has("session:ses_2")).toBe(false)
  })
})
