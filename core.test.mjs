import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { extractPairs, outputBase, parseFlags, readMessagePages, stripPluginNoise, toHtml, toTreeHtml, toTreeSvg } from "./core.mjs";

test("两种模式的文件名前缀不冲突", () => {
  assert.equal(outputBase(12, "2026-11-20T13-30", false), "r12_2026-11-20T13-30");
  assert.equal(outputBase(12, "2026-11-20T13-30", true), "r12_2026-11-20T13-30-just-list");
});

test("默认使用思路模式，--just-list 可与 --all 一起使用", () => {
  assert.equal(parseFlags().justList, false);
  assert.equal(parseFlags("--model=provider/model").model, "provider/model");
  assert.deepEqual(parseFlags("--just-list --all"), { all: true, justList: true, clear: false, model: undefined });
});

test("导出时过滤命令和插件通知", () => {
  const messages = [
    { type: "user", text: "/untangle-me --just-list" },
    { type: "synthetic", text: "[/untangle-me] 已生成文件" },
    { type: "assistant", text: "插件结果" },
  ];
  messages.push({ type: "user", text: "/untangle-me-notes 是什么？" }, { type: "assistant", text: "正常回答" });
  const pairs = extractPairs(stripPluginNoise(messages));
  assert.deepEqual(pairs.map(({ question, answer }) => [question, answer]), [["/untangle-me-notes 是什么？", "正常回答"]]);
});

test("读取 compact 前后的所有分页，并保留时间顺序", async () => {
  const pages = [
    { data: [{ type: "user", text: "早期问题" }, { type: "assistant", text: "早期回答" }], cursor: { next: "page2" } },
    { data: [{ type: "compaction" }, { type: "user", text: "后续问题" }, { type: "assistant", text: "后续回答" }], cursor: { next: null } },
  ];
  const cursors = [];
  const messages = await readMessagePages(async (cursor) => {
    cursors.push(cursor);
    return pages[cursor ? 1 : 0];
  });
  assert.deepEqual(cursors, [undefined, "page2"]);
  assert.deepEqual(extractPairs(messages).map((pair) => pair.question), ["早期问题", "后续问题"]);
  await assert.rejects(readMessagePages(async () => ({ data: [], cursor: { next: "same" } })), /游标重复/);
});

test("思路图向下展开，独立主题横向排列", () => {
  const tree = { nodes: [
    { id: "a", parent: null, question: "主题一", turn: 1 },
    { id: "b", parent: "a", question: "追问", turn: 2 },
    { id: "c", parent: null, question: "主题二", turn: 3 },
  ] };
  const svg = toTreeSvg(tree);
  const boxes = [...svg.matchAll(/<rect class="node-box[^"]*"[^>]* x="([\d.]+)" y="([\d.]+)"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
  assert.equal(boxes.length, 3);
  assert.equal(boxes[0].x, boxes[1].x);
  assert.ok(boxes[1].y > boxes[0].y);
  assert.ok(boxes[2].x > boxes[0].x);
  assert.doesNotMatch(svg, /stroke-dasharray|虚线/);
});

test("并列子节点连线和边框样式相同", () => {
  const nodes = [
    { id: "a", parent: null, question: "根" },
    { id: "b", parent: "a", question: "方案一" },
    { id: "c", parent: "a", question: "方案二", chain: "branch" },
  ];
  const svg = toTreeSvg({ nodes });
  const edges = [...svg.matchAll(/<path class="edge"[^>]+>/g)].map((match) => match[0]);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((edge) => edge.includes('stroke-width="2.5"')));
  assert.doesNotMatch(svg, /stroke-dasharray/);
});

test("两种 HTML 脑图都能拖动和复位", () => {
  const tree = { nodes: [{ id: "a", parent: null, question: "问题", turn: 1 }] };
  for (const html of [toHtml([{ turn: 1, question: "问题", answer: "回答" }]), toTreeHtml(tree)]) {
    assert.match(html, /class="map-reset"/);
    assert.match(html, /\.map-reset\s*\{[^}]*right:\s*10px/);
    const handlers = {};
    const resetHandlers = {};
    const map = {
      scrollLeft: 50, scrollTop: 60,
      classList: { add() {}, remove() {} },
      setPointerCapture() {},
      addEventListener(name, handler) { handlers[name] = handler; },
    };
    const reset = { addEventListener(name, handler) { resetHandlers[name] = handler; } };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    runInNewContext(script, { document: { querySelector: (selector) => selector === ".map" ? map : reset } });
    handlers.pointerdown({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} });
    handlers.pointermove({ pointerId: 1, clientX: 80, clientY: 70 });
    assert.equal(map.scrollLeft, 70);
    assert.equal(map.scrollTop, 90);
    handlers.pointerup({ pointerId: 1 });
    resetHandlers.click();
    assert.equal(map.scrollLeft, 0);
    assert.equal(map.scrollTop, 0);
  }
});

test("LLM 节点明细显示原始问答，缺失或冲突的引用不伪造原文", () => {
  const pairs = [
    { turn: 1, questionId: "u1", answerId: "a1", question: "原始问题\n第二行", answer: "完整回答 <安全>" },
    { turn: 2, questionId: "u2", answerId: "a2", question: "另一问题", answer: "另一回答" },
  ];
  const nodes = [
    { id: "a", parent: null, turn: 1, questionId: "u1", answerId: "a1", question: "摘要问题", answer: "摘要回答" },
    { id: "b", parent: null, turn: 2, questionId: "missing", question: "无引用", answer: "虚构摘要" },
    { id: "c", parent: null, turn: 1, questionId: "u1", answerId: "a2", question: "冲突", answer: "冲突摘要" },
    { id: "d", parent: null, turn: 2, question: "仅轮次", answer: "简短摘要" },
  ];
  const html = toTreeHtml({ nodes }, pairs);
  const details = [...html.matchAll(/<details class="turn[\s\S]*?<\/details>/g)].map((match) => match[0]);
  assert.match(details[0], /原始问题\n第二行/);
  assert.match(details[0], /完整回答 &lt;安全&gt;/);
  assert.doesNotMatch(details[0], /摘要回答/);
  assert.match(details[1], /未找到对应问答原文/);
  assert.match(details[2], /未找到对应问答原文/);
  assert.match(details[3], /另一回答/);
});
