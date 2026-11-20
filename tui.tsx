import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { UntangleMyMind } from "./rpc"

export default Plugin.define({
  id: "untangle-my-mind.tui",
  setup(context) {
    const rpc = context.client.rpc(UntangleMyMind)
    const [active, setActive] = createSignal<string[]>([])
    const [tick, setTick] = createSignal(0)
    const [started, setStarted] = createSignal<Record<string, number>>({})
    let updated = false
    const unsubscribe = rpc.events.on("progress", (event) => {
      if (event.location.directory !== (context.location ?? context.data.location.default()).directory) return
      updated = true
      const { sessionID, active: running } = event.data as { sessionID: string, active: boolean }
      setActive((current) => running ? [...new Set([...current, sessionID])] : current.filter((id) => id !== sessionID))
      setStarted((current) => {
        const next = { ...current }
        if (running) next[sessionID] = Date.now()
        else delete next[sessionID]
        return next
      })
    })
    void rpc.active({}).then((result) => {
      if (updated) return
      const sessions = (result as { sessions: string[] }).sessions
      setActive(sessions)
      setStarted(Object.fromEntries(sessions.map((id) => [id, Date.now()])))
    }).catch(() => {})
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const visible = () => {
          tick()
          const id = input.sessionID
          return id && active().includes(id) && Date.now() - (started()[id] ?? Date.now()) >= 10000
        }
        return <Show when={visible()}><text>Untangle My Mind 正在生成{".".repeat((tick() % 6) + 1)}</text></Show>
      },
    })
    return () => {
      clearInterval(timer)
      unsubscribe()
      unregister()
    }
  },
})
