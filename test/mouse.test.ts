import "./helpers.ts";
import { createFakePi, plainTheme } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import extension, { CompactExternalGroupComponent, type CompactExternalGroup } from "../index.ts";

initTheme("dark");
const fake = createFakePi();
before(async () => { extension(fake.pi as any); await fake.emit("session_start"); });
after(async () => { await fake.emit("session_shutdown"); });
const plain = (component: any, width = 120): string[] => component.render(width).map(stripTerminalSequences);
const mouse = (y: number, changes: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click", button: "left", x: 2, y, screenX: 12, screenY: 10 + y,
	width: 120, height: 100, shift: false, alt: false, ctrl: false, clickCount: 1, ...changes,
});
function state(): CompactExternalGroup {
	return { sealed: true, thinkingActive: false, thinking: "", tools: [
		{ id: "1", name: "bash", args: { command: "npm test" }, status: "success", resultText: "测试输出详情", startedAt: 0, endedAt: 100 },
		{ id: "2", name: "edit", args: { path: "auth.ts" }, status: "error", resultText: "修改失败详情", startedAt: 100, endedAt: 200 },
		{ id: "3", name: "edit", args: { path: "other.ts" }, status: "success", resultText: "修改成功详情", startedAt: 200, endedAt: 300 },
		{ id: "4", name: "read", args: { path: "auth.ts" }, status: "pending", resultText: "", startedAt: Date.now() },
	] };
}

test("摘要统计全部调用，按首次出现顺序排列，保留失败和运行状态", () => {
	const data = state();
	const group = new CompactExternalGroupComponent(data, plainTheme);
	assert.match(plain(group)[0]!, /bash×1 edit×2 read×1 · 失败1 · 运行中1/);
	assert.match(plain(group, 36)[0]!, /失败1 · 运行中1$/, "窄屏优先保留完整状态");
	data.tools.push({ ...data.tools[0]!, id: "5" });
	assert.match(plain(group)[0]!, /bash×2 edit×2 read×1/);
	group.setExpanded(true);
	assert.match(plain(group)[0]!, /▾.*bash×2 edit×2 read×1/);
});

test("外部组单击标题切换，空白/正文/拖选/滚轮/修饰键不抢占", () => {
	const data = state(); data.tools[3]!.status = "success";
	const group = new CompactExternalGroupComponent(data, plainTheme);
	const collapsed = plain(group);
	for (const event of [
		mouse(1), mouse(0, { x: 119 }), mouse(0, { x: 0 }),
		mouse(0, { type: "press" }), mouse(0, { type: "release" }), mouse(0, { type: "drag" }),
		mouse(0, { type: "wheel", wheelDelta: 1 }), mouse(0, { button: "right" }),
		mouse(0, { ctrl: true }), mouse(0, { shift: true }), mouse(0, { alt: true }), mouse(0, { clickCount: 2 }),
	]) assert.equal(group.handleMouse(event), undefined);
	assert.deepEqual(plain(group), collapsed);
	const result = group.handleMouse(mouse(0));
	assert.equal(result?.handled, true);
	assert.equal(result?.render, true);
	assert.equal(result?.focus, undefined, "不要夺走编辑器焦点");
	assert.equal(result?.capture, undefined);
	assert.equal(result?.target.component, group);
	assert.equal(plain(group).length, 1 + data.tools.length, "一级展开只有标题和每个工具一行");
	assert.doesNotMatch(plain(group).join("\n"), /测试输出详情/);
	assert.equal(group.handleMouse(mouse(0))?.handled, true);
	assert.deepEqual(plain(group), collapsed);
});

test("真实 Container 路由标题点击，只展开该组且不调用隐藏工具渲染器", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	let renders = 0;
	const makeTool = (name: string, id: string) => {
		const component = new ToolExecutionComponent(name, id, { path: `${id}.ts` }, {}, {
			name, renderResult: () => { renders++; return new Text("原生结果", 0, 0); },
		} as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(component);
		component.updateResult({ content: [{ type: "text", text: `${id}详细输出` }], details: undefined, isError: false }, false);
		return component;
	};
	makeTool("read", "a");
	makeTool("plan_mode_complete", "native-boundary");
	makeTool("edit", "b");
	await fake.emit("agent_end");
	const groups = chat.children.filter((child: any) => child.toolName === "group") as any[];
	assert.equal(groups.length, 2);
	const lines = plain(chat);
	const row = lines.findIndex((line) => /▸ read×1/.test(line));
	assert.ok(row >= 1);
	const beforeRenders = renders;
	assert.equal(chat.handleMouse(mouse(row - 1, { height: lines.length })), undefined, "组前空行不可点击");
	assert.equal(chat.handleMouse(mouse(row, { height: lines.length }))?.target.component, groups[0]);
	assert.equal(groups[0].expanded, true);
	assert.equal(groups[1].expanded, false);
	assert.match(plain(chat).join("\n"), /read.*a\.ts/);
	assert.doesNotMatch(plain(chat).join("\n"), /a详细输出/);
	assert.equal(renders, beforeRenders, "点击不应走隐藏工具的原生渲染/鼠标布局");
	groups[0].setExpanded(false);
	assert.match(plain(chat)[row]!, /▸ read×1/);
	chat.clear();
});

test("fullscreen 原生 SGR 按下/松开生成单击并保持输入焦点", () => {
	let input: (data: string) => void = () => {};
	const noop = () => {};
	const terminal = {
		columns: 120, rows: 30, kittyProtocolActive: false,
		start: (onInput: (data: string) => void) => { input = onInput; }, stop: noop,
		drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
		clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop,
	};
	const data = state(); data.tools[3]!.status = "success";
	const group = new CompactExternalGroupComponent(data, plainTheme);
	const typed: string[] = [];
	const editor = { render: () => ["输入框"], invalidate: noop, handleInput: (text: string) => typed.push(text) };
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	tui.addChild(group); tui.addChild(editor); tui.setFocus(editor);
	try {
		tui.start(); tui.renderNow();
		input("\u001b[<0;3;1M"); // 按下不切换，不抢拖选手势。
		assert.match(plain(group)[0]!, /^ ▸/);
		input("\u001b[<0;3;1m");
		assert.match(plain(group)[0]!, /^ ▾/);
		tui.renderNow();
		input("\u001b[<0;6;3M"); input("\u001b[<32;10;3M"); input("\u001b[<0;10;3m");
		assert.equal(tui.hasActiveSelection(), true, "正文仍走原生拖选路径");
		assert.match(plain(group)[0]!, /^ ▾/, "拖选正文不切换展开状态");
		input("z");
		assert.deepEqual(typed, ["z"]);
		// 换一个标题位置，避免被判为双击。
		input("\u001b[<0;4;1M"); input("\u001b[<0;4;1m");
		assert.match(plain(group)[0]!, /^ ▸/);
	} finally { tui.stop(); }
});

test("历史锚定组点击后，经主题失效/宽度变化仍保留各自状态，Ctrl+O 可统一覆盖", () => {
	const component = new AssistantMessageComponent({ role: "assistant", content: [
		{ type: "thinking", thinking: "第一段思考\n展开详情甲" }, { type: "text", text: "第一段正文" },
		{ type: "thinking", thinking: "第二段思考\n展开详情乙" }, { type: "text", text: "第二段正文" },
	] } as any) as any;
	const chat = new Container(); chat.addChild(component);
	const lines = plain(chat);
	const row = lines.findIndex((line) => /▸ 思考记录/.test(line));
	assert.ok(row >= 0);
	assert.equal(chat.handleMouse(mouse(row, { height: lines.length }))?.handled, true);
	const groups = component.contentContainer.children.filter((child: any) => child.toolName === "group");
	assert.deepEqual(groups.map((group: any) => group.expanded), [true, false]);
	for (const width of [36, 120, 240]) {
		component.invalidate(); plain(chat, width);
		assert.deepEqual(groups.map((group: any) => group.expanded), [true, false]);
	}
	component.updateContent({ role: "assistant", content: [
		{ type: "thinking", thinking: "更新后的思考\n更新详情" }, { type: "text", text: "第一段正文" },
		{ type: "thinking", thinking: "第二段思考\n展开详情乙" }, { type: "text", text: "第二段正文" },
	] });
	const updated = plain(chat).join("\n");
	assert.match(updated, /更新详情/);
	assert.doesNotMatch(updated, /展开详情甲/);
	assert.deepEqual(groups.map((group: any) => group.expanded), [true, false]);
	component.setExpanded(false);
	assert.deepEqual(groups.map((group: any) => group.expanded), [false, false]);
	component.setExpanded(true);
	assert.deepEqual(groups.map((group: any) => group.expanded), [true, true]);
	chat.clear();
});
