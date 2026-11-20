export async function readMessagePages(fetchPage) {
  const all = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page?.data) || !page.cursor) throw new Error("完整会话历史接口返回了无法识别的分页数据");
    all.push(...page.data);
    cursor = page.cursor.next;
    if (cursor && seen.has(cursor)) throw new Error("完整会话历史分页游标重复");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return all;
}

export function roleOf(message) {
  if (typeof message?.type === "string") return message.type;
  if (typeof message?.info?.role === "string") return message.info.role;
  if (typeof message?.role === "string") return message.role;
  return "";
}

export function partsOf(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(message?.parts)) return message.parts;
  return [];
}

function textParts(parts) {
  return parts.filter(
    (part) => part?.type === "text" && typeof part.text === "string" && part.text.trim(),
  );
}

export function allText(message) {
  if (typeof message?.text === "string" && message.text.trim()) return message.text.trim();
  return textParts(partsOf(message))
    .map((part) => part.text.trim())
    .join("\n\n")
    .trim();
}

export function finalText(message) {
  if (typeof message?.text === "string" && message.text.trim()) return message.text.trim();
  const parts = partsOf(message);
  const texts = textParts(parts);
  if (texts.length === 0) return "";
  let cut = -1;
  parts.forEach((part, index) => {
    if (part?.type === "tool" || part?.type === "reasoning") cut = index;
  });
  const tail = texts.filter((part) => parts.indexOf(part) > cut);
  return (tail.length ? tail : texts)
    .map((part) => part.text.trim())
    .join("\n\n")
    .trim();
}

function finishOf(message) {
  return message?.finish ?? message?.info?.finish ?? "";
}

function idOf(message) {
  return message?.id ?? message?.info?.id ?? message?.messageID ?? undefined;
}

function timeOf(message) {
  const value = message?.time?.created ?? message?.info?.time?.created ?? undefined;
  if (value == null) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return typeof value === "string" ? value : undefined;
  return new Date(ms).toISOString();
}

// 插件自产消息不算用户提问：命令调用、插件触发的报告 prompt，
// 以及紧随其后的模型回复都要在提取前剔除，否则下次运行会把它们当成一轮问答。
export function stripPluginNoise(input) {
  const messages = Array.isArray(input) ? input : [];
  const out = [];
  let skipAssistant = false;
  for (const message of messages) {
    const role = roleOf(message);
    const injected = /^(?:\/untangle-me(?=\s|$)|\[\/untangle-me\])/.test(allText(message).trim());
    if ((role === "user" || role === "synthetic") && injected) {
      skipAssistant = true;
      continue;
    }
    if (role === "user") skipAssistant = false;
    if (role === "assistant" && skipAssistant) continue;
    out.push(message);
  }
  return out;
}

export function extractPairs(input, session = {}) {
  const messages = Array.isArray(input)
    ? input
    : Array.isArray(input?.data)
      ? input.data
      : Array.isArray(input?.messages)
        ? input.messages
        : [];

  const pairs = [];
  let current = null;
  let turn = 0;

  for (const message of messages) {
    const role = roleOf(message);

    if (role === "user") {
      if (current) pairs.push(current);
      const question = allText(message);
      if (!question) {
        current = null;
        continue;
      }
      turn += 1;
      current = {
        sessionId: session.id ?? undefined,
        sessionTitle: session.title ?? undefined,
        turn,
        question,
        questionId: idOf(message),
        questionAt: timeOf(message),
        answer: "",
        answerId: undefined,
        answerAt: undefined,
        finish: undefined,
      };
      continue;
    }

    if (role !== "assistant" || !current) continue;

    const answer = finalText(message);
    if (!answer) continue;

    const finish = finishOf(message);
    const terminal = finish === "stop" || finish === "complete" || finish === "end_turn";
    if (!current.answer || terminal || !current.finish) {
      current.answer = answer;
      current.answerId = idOf(message);
      current.answerAt = timeOf(message);
      current.finish = finish || undefined;
    }
  }

  if (current) pairs.push(current);
  return pairs;
}

export function toJsonl(pairs) {
  return pairs.map((pair) => JSON.stringify(pair)).join("\n") + (pairs.length ? "\n" : "");
}

function mermaidSafe(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/"/g, "'")
    .replace(/[\[\]]/g, "")
    .trim();
}

export function toMermaid(pairs, title = "Session") {
  const lines = ["mindmap", `  root(("${mermaidSafe(title)}"))`];
  for (const pair of pairs) {
    lines.push(`    Q${pair.turn}["${mermaidSafe(pair.question)}"]`);
    lines.push(`      A${pair.turn}["${mermaidSafe(pair.answer)}"]`);
    if (pair.answerAt) lines.push(`        T${pair.turn}["${mermaidSafe(pair.answerAt)}"]`);
  }
  return lines.join("\n") + "\n";
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text, maxChars, maxLines) {
  const clean = String(text ?? "").replace(/\r?\n/g, " ").trim();
  const lines = [];
  let i = 0;
  for (; i < clean.length && lines.length < maxLines; i += maxChars) {
    lines.push(clean.slice(i, i + maxChars));
  }
  if (i < clean.length) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + "…";
  return lines;
}

function truncate(text, maxChars) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? clean.slice(0, maxChars) + "…" : clean;
}

function textBlock(lines, x, y, anchor = "start") {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * 18}" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="13" fill="#2C2C2A" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(line)}</text>`,
    )
    .join("\n");
}

export function toSvg(pairs, title = "Session") {
  const rowGap = 140;
  const height = Math.max(360, pairs.length * rowGap + 120);
  const width = 1400;
  const rootY = height / 2;
  const rootLines = wrapText(title, 14, 2);

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeXml(title)} · Q&amp;A mind map</title>`,
    `<desc>${pairs.length} question and final-answer pairs</desc>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#FAFAF8"/>`,
  ];

  pairs.forEach((pair, index) => {
    const y = 80 + index * rowGap;
    const qLines = wrapText(`Q${pair.turn} · ${pair.question}`, 22, 3);
    const aLines = wrapText(`A${pair.turn} · ${pair.answer}`, 48, 4);
    const qHeight = Math.max(56, qLines.length * 18 + 20);
    const aHeight = Math.max(56, aLines.length * 18 + 20);
    const qY = y - qHeight / 2;
    const aY = y - aHeight / 2;

    parts.push(
      `<path d="M230 ${rootY} C285 ${rootY}, 285 ${y}, 330 ${y}" fill="none" stroke="#85B7EB" stroke-width="2"/>`,
      `<path d="M650 ${y} C700 ${y}, 700 ${y}, 750 ${y}" fill="none" stroke="#5DCAA5" stroke-width="2"/>`,
      `<rect x="330" y="${qY}" width="320" height="${qHeight}" rx="12" fill="#E1F5EE" stroke="#0F6E56" stroke-width="1"/>`,
      textBlock(qLines, 346, y - ((qLines.length - 1) * 18) / 2),
      `<rect x="750" y="${aY}" width="610" height="${aHeight}" rx="12" fill="#F1EFE8" stroke="#888780" stroke-width="1"/>`,
      textBlock(aLines, 766, y - ((aLines.length - 1) * 18) / 2),
    );
  });

  parts.push(
    `<rect x="40" y="${rootY - 42}" width="190" height="84" rx="16" fill="#E6F1FB" stroke="#185FA5" stroke-width="1.5"/>`,
    textBlock(rootLines, 135, rootY - ((rootLines.length - 1) * 18) / 2 - 8, "middle"),
    `<text x="135" y="${rootY + 24}" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" fill="#185FA5" text-anchor="middle" dominant-baseline="central">${pairs.length} 组问答</text>`,
    `</svg>`,
  );

  return parts.join("\n") + "\n";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const mapControlsStyle = `
.map-wrap { position: relative; margin-bottom: 28px; }
.map { max-height: 70vh; margin-bottom: 0; cursor: grab; user-select: none; }
.map.dragging { cursor: grabbing; }
.map-reset { position: absolute; top: 10px; right: 10px; z-index: 1; padding: 6px 10px; border: 1px solid #c9c8c0; border-radius: 6px; background: #fff; color: #23221f; cursor: pointer; }
`;

function interactiveMap(svg) {
  return `<div class="map-wrap"><button class="map-reset" type="button" aria-label="复位脑图位置">复位</button><div class="map">${svg}</div></div>`;
}

const mapControlsScript = `<script>
(() => {
  const map = document.querySelector(".map");
  const reset = document.querySelector(".map-reset");
  let drag = null;
  map.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: map.scrollLeft, top: map.scrollTop };
    map.setPointerCapture(event.pointerId);
    map.classList.add("dragging");
    event.preventDefault();
  });
  map.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    map.scrollLeft = drag.left - (event.clientX - drag.x);
    map.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    map.classList.remove("dragging");
  };
  map.addEventListener("pointerup", endDrag);
  map.addEventListener("pointercancel", endDrag);
  map.addEventListener("lostpointercapture", endDrag);
  reset.addEventListener("click", () => { map.scrollLeft = 0; map.scrollTop = 0; });
})();
</script>`;

export function toHtml(pairs, title = "Session") {
  const items = pairs
    .map((pair) => {
      const meta = [pair.answerAt, pair.finish ? `finish: ${pair.finish}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `<details class="turn"${pair.turn === 1 ? " open" : ""}>
  <summary><span class="badge">Q${pair.turn}</span> ${escapeHtml(pair.question)}</summary>
  <div class="answer">${escapeHtml(pair.answer)}</div>
  ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
</details>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Q&amp;A mind map</title>
<style>
:root { color-scheme: light; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px; background: #f7f7f5; color: #23221f; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
.hint { font-size: 13px; color: #6b6963; margin-bottom: 24px; }
.map { width: 100%; overflow: auto; border: 1px solid #e3e1da; border-radius: 12px; background: #fafaf8; margin-bottom: 28px; }
.map svg { display: block; }
${mapControlsStyle}
.details-title { font-size: 14px; font-weight: 500; margin: 24px 0 12px; color: #5f5e5a; }
.turn { background: #fff; border: 1px solid #e3e1da; border-radius: 10px; margin-bottom: 12px; padding: 12px 16px; }
summary { cursor: pointer; font-size: 14px; line-height: 1.6; }
.badge { display: inline-block; background: #e6f1fb; color: #185fa5; border-radius: 5px; padding: 1px 7px; margin-right: 8px; font-size: 12px; }
.answer { margin-top: 12px; padding: 12px 14px; background: #f1f8f4; border-left: 3px solid #1d9e75; border-radius: 6px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
.meta { margin-top: 8px; font-size: 12px; color: #888780; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="hint">共 ${pairs.length} 组问答 · 上方为脑图，下方为明细</div>
${interactiveMap(toSvg(pairs, title))}
<div class="details-title">问答明细</div>
${items}
${mapControlsScript}
</body>
</html>
`;
}

// ---------- 命令参数 ----------

export function parseFlags(text = "") {
  const flags = { all: false, justList: false, clear: false, model: undefined };
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--all") flags.all = true;
    else if (token === "--clear") flags.clear = true;
    else if (token === "--just-list") flags.justList = true;
    else if (token === "--model" && tokens[i + 1]) {
      flags.model = tokens[++i];
    } else if (token.startsWith("--model=")) {
      flags.model = token.slice("--model=".length);
    }
  }
  return flags;
}

export function outputBase(turns, stamp, justList) {
  return `r${turns}_${stamp}${justList ? "-just-list" : ""}`;
}

export function safeDirName(name) {
  const clean = String(name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 80);
  return clean || "Session";
}

// ---------- LLM 思路脑图 ----------

export function buildLlmPrompt(pairs, title = "Session") {
  const compact = pairs.map((pair) => ({
    turn: pair.turn,
    questionId: pair.questionId,
    question: pair.question,
    answerId: pair.answerId,
    answer:
      String(pair.answer ?? "").length > 1500
        ? String(pair.answer).slice(0, 1500) + "…(截断)"
        : pair.answer,
    answerAt: pair.answerAt,
  }));

  return [
    "你在把一段编程会话的「提问 + 最终回答」重组成一张思路演化脑图。先理解这张图的组织语义，再输出节点。",
    "",
    "【脑图如何分解和组织 —— 最重要】",
    "这张图表达的是思路如何生长，不是按时间平铺的问答清单。",
    "1) 一个节点 = 一组问答体：一个提问 + 它的最终回答。节点里必须同时保留提问意图和回答要点，不要只写一个抽象标签。",
    "2) 父子节点 = 同一件事在往下走：后一个提问是对前一个话题的追问、细化、纠错、落地实现、验收或修复，就挂成它的子节点，形成一条越走越深的线。",
    "3) 兄弟节点 = 同一个问题上分出不同方向：方案对比、多条实现路径、备选方案、发散提问、不同技术选型，都挂到它们共同的那个问题节点下，彼此并列。",
    "4) 只有真正换了新话题，才把该节点的 parent 设为 null，另起一条线。",
    "",
    "【如何为每个问答决定 parent】",
    "按输入的时间顺序逐个处理，每一个问答都必须生成一个节点：",
    "- 先找到语义上最紧密相关、且时间更早的问答节点。",
    "- 若当前问答是顺着那个问题继续深入（追问 / 细化 / 实现 / 修复 / 验收）→ parent 取那个节点。",
    "- 若当前问答是回到之前某个问题、从它出发讨论另一个方向（而不是继续深入）→ parent 取那个共同的问题节点，与它的其他子节点并列。",
    "- 若与之前所有问答都无关（换了新话题）→ parent = null。",
    "- 不要把绝大多数问答都平铺挂到同一个节点下，要还原真实的层层深入与横向比较。",
    "",
    "【节点字段与信息密度】",
    "每个节点输出：",
    "  id：n1、n2…；parent：父节点 id，或 null 表示一条线的起点。",
    "  turn / questionId / answerId：从输入原样抄，用于溯源。",
    "  head：这个提问想达成什么，简短概括问题意图，不超过 16 字。只写内容本身的意思，不要写任何结构类别或标签。",
    "  question：提问要点，不超过 40 字，保留关键意图与约束。",
    "  answer：回答摘要，不超过 80 字，只保留结论、关键决策、方案名、落地位置，不要复述中间过程和寒暄。",
    "  next：当回答的结尾涉及与用户交互时，专门写这一项，不超过 24 字。所谓交互包括：反问用户、请用户选择、请求确认、等待用户补充信息、把下一步交给用户决定。没有这类内容就填空字符串。它的作用是把「上一轮的悬而未决」和「下一轮为什么这样问」接起来。",
    "",
    "【输出格式】",
    "只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
    '格式：{"title":"会话主题","nodes":[{"id":"n1","parent":null,"turn":1,"questionId":"u1","answerId":"a1","head":"加一个登录入口","question":"帮我加个登录","answer":"在 login.ts 加表单校验并调用 /auth/login，成功后写入 token","next":"问是否要接第三方登录"}]}',
    "约束：所有 parent 要么为 null，要么指向已存在的 id；一个输入问答对应一个节点，不合并、不遗漏、不凭空新增。",
    "",
    "输入 JSON：",
    JSON.stringify({ title, pairs: compact }, null, 2),
  ].join("\n");
}

export function parseLlmTree(text) {
  let source = String(text ?? "").trim();
  source = source.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("大模型未返回 JSON 对象");

  let obj;
  try {
    obj = JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new Error(`大模型返回的 JSON 无法解析：${error.message}`);
  }

  const raw = Array.isArray(obj) ? obj : obj?.nodes;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("大模型返回的节点列表为空");

  const nodes = raw
    .map((node, index) => {
      const question = String(node?.question ?? node?.q ?? "").trim();
      const answer = String(node?.answer ?? node?.a ?? "").trim();
      const label = String(node?.label ?? node?.title ?? "").trim();
      const refs = [
        node?.questionId,
        node?.answerId,
        ...(Array.isArray(node?.evidence) ? node.evidence : []),
      ]
        .filter(Boolean)
        .map((item) => String(item));
      const turnValue = Number(node?.turn);
      const head = String(node?.head ?? node?.intent ?? node?.summary ?? "").trim();
      const next = String(node?.next ?? node?.followup ?? node?.interaction ?? "").trim();
      return {
        id: String(node?.id ?? node?.nodeId ?? `n${index + 1}`),
        parent: node?.parent == null ? null : String(node.parent),
        turn: Number.isFinite(turnValue) && turnValue > 0 ? turnValue : undefined,
        head,
        topic: String(node?.topic ?? "").trim() || head || "问答",
        question: question || label,
        answer,
        next,
        // 兼容旧版返回：chain / direction 仍然接受，但仅作视觉参考，不再要求模型输出。
        chain: /branch|分叉|旁支/i.test(String(node?.chain ?? "")) ? "branch" : "main",
        direction: String(node?.direction ?? "").trim(),
        questionId: node?.questionId == null ? undefined : String(node.questionId),
        answerId: node?.answerId == null ? undefined : String(node.answerId),
        evidence: [...new Set(refs)],
        label: label || question,
      };
    })
    .filter((node) => node.question || node.label);

  if (nodes.length === 0) throw new Error("大模型返回的节点均无有效 question");

  const ids = new Set();
  for (const node of nodes) {
    let id = node.id;
    let suffix = 2;
    while (ids.has(id)) id = `${node.id}_${suffix++}`;
    node.id = id;
    ids.add(id);
  }

  const roots = nodes.filter((node) => node.parent == null);
  const root = roots[0] ?? nodes[0];
  if (roots.length === 0) root.parent = null;
  for (const node of nodes) {
    if (node === root) continue;
    if (node.parent != null && (!ids.has(node.parent) || node.parent === node.id)) {
      node.parent = root.id;
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set([node.id]);
    let cursor = node;
    while (cursor.parent != null) {
      if (seen.has(cursor.parent)) {
        node.parent = root.id;
        break;
      }
      seen.add(cursor.parent);
      cursor = byId.get(cursor.parent);
      if (!cursor) break;
    }
  }

  nodes.sort(
    (a, b) => (a.turn ?? Number.MAX_SAFE_INTEGER) - (b.turn ?? Number.MAX_SAFE_INTEGER),
  );

  return { title: String(obj?.title ?? "思路脑图"), nodes };
}

const ROW_GAP = 210;
const TREE_TOP = 160;

function treeLayout(tree) {
  const nodes = tree?.nodes ?? [];
  const byParent = new Map();
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node);
  for (const node of nodes) {
    const key = node.parent ?? "__root__";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }

  const roots = nodes.filter((node) => !byId.has(node.parent));
  const depth = new Map();
  const xOf = new Map();
  const chainIndex = new Map();
  let row = 0;

  // 一条根链 = 一套色系；整棵子树都继承根的颜色。
  const markChain = (node, index) => {
    if (chainIndex.has(node.id)) return;
    chainIndex.set(node.id, index);
    for (const child of byParent.get(node.id) ?? []) markChain(child, index);
  };
  roots.forEach((node, index) => markChain(node, index));

  const walk = (node, level) => {
    depth.set(node.id, level);
    const children = byParent.get(node.id) ?? [];
    if (children.length === 0) {
      xOf.set(node.id, 60 + row * 410);
      row += 1;
      return xOf.get(node.id);
    }
    const ys = children.map((child) => walk(child, level + 1));
    const x = (ys[0] + ys[ys.length - 1]) / 2;
    xOf.set(node.id, x);
    return x;
  };
  roots.forEach((node) => walk(node, 0));

  let maxDepth = 0;
  depth.forEach((value) => {
    if (value > maxDepth) maxDepth = value;
  });

  return {
    nodes,
    byParent,
    depth,
    xOf,
    maxDepth,
    rows: row,
    roots,
    paletteOf: (node) => CHAIN_PALETTES[(chainIndex.get(node.id) ?? 0) % CHAIN_PALETTES.length],
  };
}

// 每条根链一套色系：fill 用于普通节点，deep 用于链首，stroke 用于描边/连线/意图文字。
// 想加新色系直接往数组里追加，节点数量超了会自动循环取用。
const CHAIN_PALETTES = [
  { name: "蓝", fill: "#E6F1FB", deep: "#B5D4F4", stroke: "#185FA5", text: "#0C447C" },
  { name: "青", fill: "#E1F5EE", deep: "#9FE1CB", stroke: "#0F6E56", text: "#085041" },
  { name: "紫", fill: "#EEEDFE", deep: "#CECBF6", stroke: "#534AB7", text: "#3C3489" },
  { name: "琢", fill: "#FAEEDA", deep: "#FAC775", stroke: "#854F0B", text: "#633806" },
  { name: "珊", fill: "#FAECE7", deep: "#F5C4B3", stroke: "#993C1D", text: "#712B13" },
  { name: "绿", fill: "#EAF3DE", deep: "#C0DD97", stroke: "#3B6D11", text: "#27500A" },
  { name: "绯", fill: "#FBEAF0", deep: "#F4C0D1", stroke: "#993556", text: "#72243E" },
];

// 节点的颜色 = 所属链的色系；角色只改变填充深浅与边框样式。
function nodeStyle(node, level, layout) {
  const palette = layout.paletteOf(node);
  const isRoot = level === 0;
  return {
    palette,
    fill: isRoot ? palette.deep : palette.fill,
    stroke: palette.stroke,
    width: isRoot ? 1.75 : 1,
  };
}

const FONT_FAMILY = "system-ui,-apple-system,Segoe UI,sans-serif";

// 节点/画布文字的统一样式表：只改这里，就能调字号、字重、颜色。
// color 为 null 表示跟随所在节点的描边色。
const TEXT_STYLES = {
  "map-title": { size: 16, weight: 600, color: "#23221F" },
  "map-caption": { size: 11, weight: 400, color: "#6B6963" },
  "node-head": { size: 12, weight: 600, color: null },
  "node-q": { size: 12, weight: 400, color: "#23221F" },
  "node-a": { size: 11, weight: 400, color: "#5F5E5A" },
  "node-next": { size: 11, weight: 500, color: "#8A5A10" },
  "node-ref": { size: 11, weight: 400, color: null },
};

function svgText(content, x, y, options = {}) {
  const { role = "node-q", size, color, weight, anchor = "start" } = options;
  const style = TEXT_STYLES[role] ?? TEXT_STYLES["node-q"];
  return `<text class="${role}" x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size ?? style.size}" font-weight="${weight ?? style.weight}" fill="${color ?? style.color ?? "#2C2C2A"}" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(content)}</text>`;
}

function nodeLines(node) {
  const lines = [];
  // 第一行：模型给的「问题意图」短句，没给就退回话题/提问。
  const head = node.head || node.topic || node.question;
  lines.push({ role: "node-head", text: truncate(head, 20) });
  for (const line of wrapText(`Q：${node.question}`, 28, 2)) {
    lines.push({ role: "node-q", text: line });
  }
  if (node.answer) {
    for (const line of wrapText(`A：${node.answer}`, 30, 3)) {
      lines.push({ role: "node-a", text: line });
    }
  }
  if (node.next) {
    for (const line of wrapText(`↩ 待你回应：${node.next}`, 30, 2)) {
      lines.push({ role: "node-next", text: line });
    }
  }
  return lines;
}

export function toTreeSvg(tree, title = "思路脑图") {
  const layout = treeLayout(tree);
  const nodeWidth = 360;
  const lineHeight = 16;
  const pad = 14;
  const nodes = layout.nodes;
  const width = Math.max(1000, layout.rows * 410 + 120);
  const height = Math.max(420, layout.maxDepth * ROW_GAP + TREE_TOP + 120);

  const meta = new Map();
  for (const node of nodes) {
    const lines = nodeLines(node);
    meta.set(node.id, {
      lines,
      height: Math.max(76, lines.length * lineHeight + pad * 2 + 12),
    });
  }

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeXml(title)} · 思路演化脑图</title>`,
    `<desc>${nodes.length} 组问答，按话题和父子关系排列</desc>`,
    `<rect class="canvas" x="0" y="0" width="${width}" height="${height}" fill="#FAFAF8"/>`,
    svgText(title, 40, 30, { role: "map-title" }),
    svgText(
      `共 ${nodes.length} 组问答 · 颜色=所属话题线 · 连线=话题关系 · ↩ 待你回应=该轮结尾留给你的问题`,
      40,
      52,
      { role: "map-caption" },
    ),
  ];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parent = byId.get(node.parent);
    if (!parent) continue;
    const x1 = layout.xOf.get(parent.id) + nodeWidth / 2;
    const y1 = TREE_TOP + (layout.depth.get(parent.id) ?? 0) * ROW_GAP + meta.get(parent.id).height / 2;
    const x2 = layout.xOf.get(node.id) + nodeWidth / 2;
    const y2 = TREE_TOP + (layout.depth.get(node.id) ?? 0) * ROW_GAP - meta.get(node.id).height / 2;
    const mid = (y1 + y2) / 2;
    const palette = layout.paletteOf(node);
    parts.push(
      `<path class="edge" d="M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" fill="none" stroke="${palette.stroke}" stroke-width="2.5"/>`,
    );
  }

  for (const node of nodes) {
    const level = layout.depth.get(node.id) ?? 0;
    const x = layout.xOf.get(node.id) ?? 60;
    const y = TREE_TOP + level * ROW_GAP;
    const color = nodeStyle(node, level, layout);
    const info = meta.get(node.id);
    const h = info.height;
    parts.push(
      `<rect class="node-box${level === 0 ? " root" : ""}" data-chain="${color.palette.name}" x="${x}" y="${y - h / 2}" width="${nodeWidth}" height="${h}" rx="10" fill="${color.fill}" stroke="${color.stroke}" stroke-width="${color.width}"/>`,
    );
    let ty = y - h / 2 + pad + 6;
    for (const line of info.lines) {
      const followsStroke = line.role === "node-head" || line.role === "node-ref";
      parts.push(
        svgText(line.text, x + 12, ty, {
          role: line.role,
          color: followsStroke ? color.stroke : undefined,
        }),
      );
      ty += lineHeight;
    }
    const refs = node.turn ? `第 ${node.turn} 轮` : "";
    if (refs) {
      parts.push(svgText(refs, x + 12, y + h / 2 - 10, { role: "node-ref", color: color.stroke }));
    }
  }

  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

export function toTreeMermaid(tree, title = "思路脑图") {
  const layout = treeLayout(tree);
  const lines = ["mindmap", `  root(("${mermaidSafe(title)}"))`];
  const nodes = tree?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes.filter((node) => !byId.has(node.parent));
  const visited = new Set();

  const emit = (node, indent) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const tag = node.head || node.topic;
    const text = [
      `第${node.turn ?? "?"}轮 问 ${node.question}`,
      node.answer ? `答 ${node.answer}` : "",
      node.next ? `待回应 ${node.next}` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    lines.push(
      `${"  ".repeat(indent)}${mermaidSafe(node.id)}["${mermaidSafe(`${tag}｜${text}`)}"]`,
    );
    for (const child of layout.byParent.get(node.id) ?? []) emit(child, indent + 1);
  };
  roots.forEach((node) => emit(node, 2));

  return lines.join("\n") + "\n";
}

export function toTreeHtml(tree, pairs = [], title = "思路脑图") {
  const nodes = tree?.nodes ?? [];
  const layout = treeLayout(tree);
  const byQuestionId = new Map(pairs.filter((pair) => pair.questionId).map((pair) => [pair.questionId, pair]));
  const byAnswerId = new Map(pairs.filter((pair) => pair.answerId).map((pair) => [pair.answerId, pair]));
  const byTurn = new Map(pairs.map((pair) => [pair.turn, pair]));
  const legendItems = layout.roots
    .map((root, index) => {
      const palette = CHAIN_PALETTES[index % CHAIN_PALETTES.length];
      return `<span><i class="swatch" style="background:${palette.fill};border-color:${palette.stroke}"></i>${escapeHtml(root.head || root.topic || `第 ${index + 1} 条话题线`)}</span>`;
    })
    .join("");
  const items = nodes
    .map((node) => {
      const palette = layout.paletteOf(node);
      const questionMatch = node.questionId && byQuestionId.get(node.questionId);
      const answerMatch = node.answerId && byAnswerId.get(node.answerId);
      const turnMatch = node.turn && byTurn.get(node.turn);
      // 消息 ID 优先；如模型提供的引用互相冲突，不猜测原文。
      const matches = [questionMatch, answerMatch].filter(Boolean);
      const pair = matches.length
        ? (matches.every((match) => match === matches[0]) ? matches[0] : undefined)
        : (!node.questionId && !node.answerId ? turnMatch : undefined);
      const meta = [
        node.turn ? `第 ${node.turn} 轮` : "",
        node.questionId ? `提问 ${node.questionId}` : "",
        node.answerId ? `回答 ${node.answerId}` : "",
        `id ${node.id}`,
        `parent ${node.parent ?? "—"}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return `<details class="turn" style="border-left-color:${palette.stroke}"${node.parent == null ? " open" : ""}>
  <summary><span class="badge" style="background:${palette.fill};color:${palette.text}">${escapeHtml(node.head || node.topic)}</span> ${escapeHtml(pair?.question || "未找到对应问答原文")}</summary>
  <div class="q"><b>提问原文</b> ${escapeHtml(pair?.question ?? "（未找到对应问答原文）")}</div>
  <div class="a"><b>回答原文</b> ${escapeHtml(pair ? (pair.answer || "（无回答）") : "（未找到对应问答原文）")}</div>
  <div class="meta">${escapeHtml(meta)}</div>
</details>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 思路脑图</title>
<style>
:root { color-scheme: light; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px; background: #f7f7f5; color: #23221f; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
.hint { font-size: 13px; color: #6b6963; margin-bottom: 12px; }
.legend { font-size: 12px; color: #6b6963; margin-bottom: 24px; }
.legend span { display: inline-block; margin-right: 16px; }
.key { display: inline-block; width: 22px; height: 3px; vertical-align: middle; margin-right: 6px; border-radius: 2px; background: #185fa5; }
.swatch { display: inline-block; width: 14px; height: 10px; vertical-align: middle; margin-right: 6px; border-radius: 3px; border: 1px solid; }
.map { width: 100%; overflow: auto; border: 1px solid #e3e1da; border-radius: 12px; background: #fafaf8; margin-bottom: 28px; }
.map svg { display: block; }
${mapControlsStyle}
.details-title { font-size: 14px; font-weight: 500; margin: 24px 0 12px; color: #5f5e5a; }
.turn { background: #fff; border: 1px solid #e3e1da; border-left: 3px solid #185fa5; border-radius: 10px; margin-bottom: 12px; padding: 12px 16px; }
summary { cursor: pointer; font-size: 14px; line-height: 1.6; }
.badge { display: inline-block; background: #e6f1fb; color: #0c447c; border-radius: 5px; padding: 1px 7px; margin-right: 8px; font-size: 12px; }
.q { margin-top: 10px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; }
.a { margin-top: 8px; padding: 10px 12px; background: #f1f8f4; border-radius: 6px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.next { margin-top: 8px; padding: 8px 12px; background: #fdf3e3; border-radius: 6px; font-size: 13px; line-height: 1.7; color: #7a4f0c; }
.meta { margin-top: 8px; font-size: 12px; color: #888780; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="hint">大模型把 ${pairs.length} 组问答重组为 ${nodes.length} 个节点 · 颜色对应不同话题线 · 每个节点是一组问答体</div>
<div class="legend">${legendItems}<span><i class="key"></i>连线：话题关系</span><span>↩ 待你回应：该轮结尾留给你的问题</span></div>
${interactiveMap(toTreeSvg(tree, title))}
<div class="details-title">节点明细</div>
${items}
${mapControlsScript}
</body>
</html>
`;
}

const sampleMessages = [
  { type: "user", id: "u1", text: "帮我加个登录", time: { created: 1760000000000 } },
  {
    type: "assistant",
    id: "a1",
    finish: "tool-calls",
    time: { created: 1760000001000 },
    content: [
      { type: "reasoning", text: "先看代码" },
      { type: "text", text: "我先看一下项目结构。" },
      { type: "tool", id: "t1", name: "bash", state: {} },
      { type: "text", text: "已找到 auth.ts" },
    ],
  },
  {
    type: "assistant",
    id: "a2",
    finish: "stop",
    time: { created: 1760000002000 },
    content: [
      { type: "reasoning", text: "总结" },
      { type: "text", text: "建议在 login.ts 里加 token 刷新逻辑。" },
    ],
  },
  { type: "user", id: "u2", text: "再补个登出", time: { created: 1760000003000 } },
  {
    type: "assistant",
    id: "a3",
    finish: "stop",
    time: { created: 1760000004000 },
    content: [{ type: "text", text: "登出只需清除本地 token。" }],
  },
];

export function selfTest() {
  const pairs = extractPairs(sampleMessages, { id: "ses_selftest", title: "Self test" });
  const ok =
    pairs.length === 2 &&
    pairs[0].answer.includes("token 刷新") &&
    !pairs[0].answer.includes("项目结构") &&
    pairs[1].answer.includes("清除本地 token") &&
    toMermaid(pairs).includes("mindmap") &&
    toSvg(pairs).includes("<svg") &&
    toSvg(pairs).includes("<path") &&
    toHtml(pairs).includes("<svg") &&
    parseFlags("--all --model anthropic/claude").all &&
    !parseFlags("").justList &&
    parseFlags("--just-list").justList &&
    parseFlags("--all --model anthropic/claude").model === "anthropic/claude" &&
    safeDirName("a/b:c*?") === "a-b-c";

  if (!ok) throw new Error("core self-test (extract/render/flags) failed");

  const withNoise = [
    sampleMessages[0],
    sampleMessages[1],
    sampleMessages[2],
    { type: "user", id: "cmd1", text: "/untangle-me --just-list" },
    { type: "synthetic", id: "progress1", text: "[/untangle-me] 正在总结本次会话…" },
    { type: "assistant", id: "progressReply1", finish: "stop", content: [{ type: "text", text: "正在处理" }] },
    { type: "assistant", id: "cmdReply1", finish: "stop", content: [{ type: "text", text: "已生成" }] },
    { type: "user", id: "report1", text: "[/untangle-me] 文件已经全部创建完毕。请直接回复用户" },
    { type: "assistant", id: "reportReply1", finish: "stop", content: [{ type: "text", text: "- [SVG](file:///a.svg)" }] },
    ...sampleMessages.slice(3),
  ];
  const cleaned = stripPluginNoise(withNoise);
  const cleanedPairs = extractPairs(cleaned, { id: "ses_selftest", title: "Self test" });
  const noiseOk =
    cleaned.length === sampleMessages.length &&
    cleanedPairs.length === 2 &&
    !cleanedPairs.some((pair) => pair.answer.includes("file:///")) &&
    !cleanedPairs.some((pair) => pair.question.includes("/untangle-me"));
  if (!noiseOk) throw new Error("core self-test (plugin noise filter) failed");

  const raw = [
    '{"title":"思路","nodes":[',
    '{"id":"n1","parent":null,"turn":1,"questionId":"u1","answerId":"a1","head":"加一个登录入口","question":"帮我加个登录","answer":"建议加 token 刷新","next":"问是否接第三方登录"},',
    '{"id":"n2","parent":"n1","turn":2,"questionId":"u2","answerId":"a2","head":"过期后的处理","question":"token 过期怎么办","answer":"静默刷新","next":""},',
    '{"id":"n3","parent":"n1","turn":3,"questionId":"u3","answerId":"a3","head":"接入 OAuth","question":"接 OAuth 可以吗","answer":"预留 provider 接口","next":"等确认本期是否要真接"}',
    ']}',
  ].join("");
  const tree = parseLlmTree(raw);
  const prompt = buildLlmPrompt(pairs);
  const svg = toTreeSvg(tree);
  const treeOk =
    tree.title === "思路" &&
    tree.nodes.length === 3 &&
    tree.nodes[0].parent === null &&
    tree.nodes[2].parent === "n1" &&
    tree.nodes[0].head === "加一个登录入口" &&
    tree.nodes[0].next === "问是否接第三方登录" &&
    tree.nodes[2].next === "等确认本期是否要真接" &&
    tree.nodes[0].question === "帮我加个登录" &&
    tree.nodes[0].answer === "建议加 token 刷新" &&
    tree.nodes[0].evidence.includes("u1") &&
    !prompt.includes("主链") &&
    !prompt.includes("分叉") &&
    prompt.includes("一个节点 = 一组问答体") &&
    prompt.includes("head") &&
    prompt.includes("next") &&
    prompt.includes("与用户交互") &&
    prompt.includes("u1") &&
    svg.includes("第 1 轮") &&
    svg.includes("Q：") &&
    svg.includes("A：") &&
    svg.includes("待你回应") &&
    !svg.includes("· 主链") &&
    !svg.includes("分叉") &&
    !svg.includes("stroke-dasharray") &&
    toTreeMermaid(tree).includes("mindmap") &&
    toTreeHtml(tree, pairs).includes("回答原文");

  if (!treeOk) throw new Error("core self-test (llm tree) failed");

  const cyclic = parseLlmTree(
    '{"nodes":[{"id":"x","parent":"y","question":"X"},{"id":"y","parent":"x","question":"Y"}]}',
  );
  if (!toTreeSvg(cyclic).includes("<rect") || toTreeSvg(cyclic).includes("NaN")) {
    throw new Error("core self-test (cycle guard) failed");
  }
  return pairs;
}

export function selfTestTree() {
  return parseLlmTree(
    [
      '{"title":"登录与鉴权改造","nodes":[',
      '{"id":"n1","parent":null,"turn":1,"questionId":"u1","answerId":"a1","head":"加一个可用的登录入口","question":"帮我加个登录","answer":"在 login.ts 加表单校验并调用 /auth/login，成功后写入 token","next":"问登录失败时要不要给具体原因"},',
      '{"id":"n2","parent":"n1","turn":2,"questionId":"u2","answerId":"a2","head":"token 过期后的续期","question":"token 过期了怎么办","answer":"加静默刷新，用单例 in-flight promise 去重并发请求","next":""},',
      '{"id":"n3","parent":"n2","turn":3,"questionId":"u3","answerId":"a3","head":"刷新失败时的兜底","question":"刷新也失败怎么处理","answer":"清空本地态并跳登录页，带上原路径便于回跳","next":"确认是否保留原路径做回跳"},',
      '{"id":"n4","parent":"n1","turn":4,"questionId":"u4","answerId":"a4","head":"评估接入第三方登录","question":"能不能顺带接第三方 OAuth","answer":"先抽 provider 接口，本期只留适配器不接具体实现","next":"等确认本期是否真要接"},',
      '{"id":"n5","parent":"n1","turn":5,"questionId":"u5","answerId":"a5","head":"评估加图形验证码","question":"要不要加图形验证码","answer":"暂缓，改为失败 5 次后锁定 60 秒","next":"问是否接受锁定策略代替验证码"},',
      '{"id":"n6","parent":"n4","turn":6,"questionId":"u6","answerId":"a6","head":"统一第三方回调地址","question":"回调地址怎么统一","answer":"统一走 /auth/callback，按 state 分发到各 provider","next":""},',
      '{"id":"n7","parent":null,"turn":7,"questionId":"u7","answerId":"a7","head":"把问答抽取做成插件","question":"把这套抽取做成插件","answer":"注册 /untangle-me 命令，读取会话消息后生成脑图","next":"问精简版要哪些输出格式"}',
      ']}',
    ].join(""),
  );
}
