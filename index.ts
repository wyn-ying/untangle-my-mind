import { Plugin } from "@opencode/plugin"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { UntangleMyMind } from "./rpc"
import {
  buildLlmPrompt,
  extractPairs,
  parseFlags,
  parseLlmTree,
  outputBase,
  readMessagePages,
  safeDirName,
  stripPluginNoise,
  toHtml,
  toJsonl,
  toMermaid,
  toSvg,
  toTreeHtml,
  toTreeMermaid,
  toTreeSvg,
} from "./core.mjs"

async function readAllMessages(ctx, sessionID) {
  const messageApi = (ctx.session as any).message
  const run = promisify(execFile)
  return await readMessagePages(async (cursor) => {
    let page
    if (typeof messageApi?.list === "function") {
      page = await messageApi.list({
        sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" }),
      })
    } else {
      const args = ["api", "session.message.list", "--param", `sessionID=${sessionID}`, "--param", "limit=200",
        "--param", cursor ? `cursor=${cursor}` : "order=asc"]
      try {
        const result = await run("opencode", args, { maxBuffer: 64 * 1024 * 1024 })
        page = JSON.parse(result.stdout)
      } catch (error) {
        throw new Error(`无法读取完整会话历史（不会使用 compact 后的不完整上下文）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return page
  })
}

function parseModelArg(text) {
  const value = String(text ?? "").trim()
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

async function resolveModel(ctx, modelArg, sessionID) {
  const explicit = parseModelArg(modelArg)
  if (explicit) return explicit

  // No --model given: use the model the session itself is running on, not any
  // registry-level default.
  if (sessionID && typeof ctx.session?.get === "function") {
    try {
      const ref = (await ctx.session.get({ sessionID }))?.model
      const providerID = ref?.providerID
      const id = ref?.id ?? ref?.modelID
      if (providerID && id) return { providerID, id }
    } catch {}
  }

  throw new Error("无法确定会话模型，请用 --model 提供者/模型ID 指定，例如 --model anthropic/claude-sonnet-5-5")
}

async function generateText(ctx, model, prompt) {
  if (typeof ctx.experimental?.generate?.text === "function") {
    const result = await ctx.experimental.generate.text({ model, prompt })
    return result?.text ?? (typeof result === "string" ? result : "")
  }
  if (typeof ctx.generate?.text === "function") {
    const result = await ctx.generate.text({ model, prompt })
    return result?.text ?? (typeof result === "string" ? result : "")
  }
  throw new Error("当前 OpenCode 版本不支持在插件内调用大模型")
}

function outputRoot(ctx) {
  const project = (ctx as any).location?.project?.directory
  const loaded = (ctx as any).location?.directory
  return path.join(project || loaded || process.cwd(), ".opencode", "mindmaps")
}

// 文件名用本地时间（系统时区），精确到分钟：r12_2026-11-19T23-54
function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0")
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}`,
  ].join("T")
}

function notify(ctx, sessionID, text) {
  return ctx.session.synthetic({ sessionID, text: `[/untangle-me] ${text}`, resume: false })
}

async function clearSessionFiles(root, sessionID) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: 0, remaining: 0 }
    throw error
  }
  let deleted = 0
  let remaining = 0
  const suffix = `-${safeDirName(sessionID)}`
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue
    const dir = path.join(root, entry.name)
    const files = await fs.readdir(dir, { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !/^r\d+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}(?:-llm|-just-list)?\.(?:jsonl|html|svg|md)$/.test(file.name)) continue
      await fs.unlink(path.join(dir, file.name))
      deleted++
    }
    try {
      await fs.rmdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error
      remaining++
    }
  }
  return { deleted, remaining }
}

export default Plugin.define({
  id: "untangle-my-mind",
  async setup(ctx) {
    const active = new Map<string, number>()
    const rpc = await ctx.rpc.register(UntangleMyMind, {
      active: async () => ({ sessions: [...active.keys()] }),
    })
    await ctx.command.transform((editor) => {
      editor.add({
        name: "untangle-me",
        description: "默认用模型梳理会话并生成脑图；--just-list 仅按轮次列出问答，不调用模型；--all 导出更多格式；--clear 清理本会话导出",
        execute: async ({ sessionID, prompt }) => {
          const text = prompt?.text ?? ""
          const flags = parseFlags(text)
          const files = []
          const startedAt = Date.now()
          let running = false
          let waitTimer
          let waitNotice = Promise.resolve()

          try {
            if (flags.clear) {
              const { deleted, remaining } = await clearSessionFiles(outputRoot(ctx), sessionID)
              await notify(ctx, sessionID, `已清理 ${deleted} 个文件。${remaining ? ` ${remaining} 个目录仍有其他文件，已保留。` : " 空目录已删除。"}`)
              return
            }
            running = true
            active.set(sessionID, (active.get(sessionID) ?? 0) + 1)
            if (active.get(sessionID) === 1) {
              await rpc.events.emit("progress", { sessionID, active: true }).catch(() => {})
            }
            await notify(ctx, sessionID, flags.justList
              ? "已开始生成问答脑图，正在读取会话；完成后会发送文件链接。"
              : "已开始生成思路脑图，正在读取会话；完成后会发送文件链接。")
            waitTimer = setTimeout(() => {
              waitNotice = notify(ctx, sessionID, "仍在生成脑图，请稍候。").catch(() => {})
            }, 10000)
            const session = await ctx.session.get({ sessionID })
            const messages = await readAllMessages(ctx, sessionID)
            const pairs = extractPairs(stripPluginNoise(messages), session)

            if (pairs.length === 0) {
              await notify(ctx, sessionID, "本次会话没有可提取的问答对。")
              return
            }

            const sessionName = session?.title || sessionID
            const outDir = path.join(outputRoot(ctx), `${safeDirName(sessionName)}-${safeDirName(sessionID)}`)
            await fs.mkdir(outDir, { recursive: true })

            const stamp = localStamp()
            const base = outputBase(pairs.length, stamp, flags.justList)
            const title = session?.title || "Session"

            // 两种模式均导出 JSONL + HTML + SVG；--all 追加 Mermaid，思路模式还导出节点树 JSON。
            const jsonlPath = path.join(outDir, `${base}.jsonl`)
            await fs.writeFile(jsonlPath, toJsonl(pairs), "utf8")
            files.push({ label: "问答数据 JSONL", path: jsonlPath })

            if (!flags.justList) {
              const model = await resolveModel(ctx, flags.model, sessionID)
              const answer = await generateText(ctx, model, buildLlmPrompt(pairs, title))

              const tree = parseLlmTree(answer)

              const svgPath = path.join(outDir, `${base}.svg`)
              const htmlPath = path.join(outDir, `${base}.html`)
              await fs.writeFile(svgPath, toTreeSvg(tree, `${title} · 思路脑图`), "utf8")
              await fs.writeFile(htmlPath, toTreeHtml(tree, pairs, `${title} · 思路脑图`), "utf8")
              files.push({ label: "思路脑图 SVG", path: svgPath })
              files.push({ label: "思路脑图 HTML", path: htmlPath })

              if (flags.all) {
                const treeJsonPath = path.join(outDir, `${base}.json`)
                const mdPath = path.join(outDir, `${base}.md`)
                await fs.writeFile(treeJsonPath, JSON.stringify(tree, null, 2) + "\n", "utf8")
                await fs.writeFile(mdPath, toTreeMermaid(tree, `${title} · 思路脑图`), "utf8")
                files.push({ label: "重组节点数据 JSON", path: treeJsonPath })
                files.push({ label: "Mermaid", path: mdPath })
              }
            } else {
              const svgPath = path.join(outDir, `${base}.svg`)
              const htmlPath = path.join(outDir, `${base}.html`)
              await fs.writeFile(svgPath, toSvg(pairs, title), "utf8")
              await fs.writeFile(htmlPath, toHtml(pairs, title), "utf8")
              files.push({ label: "问答脑图 SVG", path: svgPath })
              files.push({ label: "问答脑图 HTML", path: htmlPath })

              if (flags.all) {
                const mdPath = path.join(outDir, `${base}.md`)
                await fs.writeFile(mdPath, toMermaid(pairs, title), "utf8")
                files.push({ label: "Mermaid", path: mdPath })
              }
            }

            // 只在结束后发一条结果消息；这段文字面向用户，不含任何内部指令。
            const links = files
              .map((file) => `- [${file.label}](<${path.resolve(file.path)}>)\n  ${file.path}`)
              .join("\n")
            const seconds = Math.round((Date.now() - startedAt) / 1000)
            clearTimeout(waitTimer)
            await waitNotice
            await notify(ctx, sessionID, [`已生成 ${files.length} 个文件（耗时 ${seconds} 秒）：`, "", links].join("\n"))
          } catch (error) {
            clearTimeout(waitTimer)
            await waitNotice
            await notify(ctx, sessionID, `失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            clearTimeout(waitTimer)
            if (running) {
              const count = (active.get(sessionID) ?? 1) - 1
              if (count > 0) active.set(sessionID, count)
              else {
                active.delete(sessionID)
                await rpc.events.emit("progress", { sessionID, active: false }).catch(() => {})
              }
            }
          }
        },
      })
    })
  },
})
