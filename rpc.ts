import { Rpc } from "@opencode/plugin/rpc"

export const UntangleMyMind = Rpc.define({
  id: "untangle-my-mind",
  methods: {
    active: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array", items: { type: "string" } } },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    progress: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, active: { type: "boolean" } },
        required: ["sessionID", "active"],
        additionalProperties: false,
      },
    },
  },
})
