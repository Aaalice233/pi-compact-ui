import "./helpers.ts";
import { createFakePi } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

initTheme("dark");
const extension = await import("../index.ts");
const fake = createFakePi();
before(async () => {
	extension.default(fake.pi as any);
	await fake.emit("session_start");
});
after(async () => { await fake.emit("session_shutdown"); });

const thinking = (value: string) => ({ type: "thinking", thinking: value });
const text = (value: string) => ({ type: "text", text: value });
const msg = (content: any[], extra = {}) => ({ role: "assistant", content, ...extra });
const history = (message: any) => new AssistantMessageComponent(message) as any;
const plain = (component: any, width = 100) => component.render(width).map(stripTerminalSequences).join("\n");
const nestedGroups = (component: any): any[] => component.contentContainer.children.filter((child: any) => child.toolName === "group");

test("历史思考按正文边界恢复，主题失效/缩放/重复更新不丢失也不重复", () => {
	const source = msg([thinking("思考甲"), text("正文甲"), thinking("思考乙"), text("正文乙"), thinking("思考丙")]);
	const original = JSON.stringify(source);
	const component = history(source);
	component.setExpanded(true);
	for (let i = 0; i < 5; i++) {
		component.invalidate();
		const output = plain(component);
		assert.equal(nestedGroups(component).length, 3);
		for (const token of ["思考甲", "思考乙", "思考丙"]) assert.equal(output.split(token).length - 1, 1);
		const positions = ["思考甲", "正文甲", "思考乙", "正文乙", "思考丙"].map((token) => output.indexOf(token));
		assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
		for (const width of [20, 60, 120]) {
			assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		assert.equal(component.lastMessage, source, "组件必须保留未过滤的消息供下一次重建");
	}
	assert.equal(JSON.stringify(source), original, "渲染不能改动会话或模型消息");
});

test("纯思考与工具调用前的思考有展开入口，历史组静态缓存且不转圈", () => {
	for (const content of [
		[thinking("历史推理\n第二行详情")],
		[thinking("历史推理\n第二行详情"), { type: "toolCall", id: "read-1", name: "read", arguments: {} }],
	]) {
		const component = history(msg(content, { usage: { reasoning: 200 } }));
		assert.match(plain(component), /历史推理/);
		component.setExpanded(true);
		assert.match(plain(component), /第二行详情/);
		const [group] = nestedGroups(component);
		assert.equal(group.thinkingTokensFrozen, 200);
		assert.equal(group.thinkingTokensFrozenExact, true);
		assert.equal(group.needsAnimation(), false);
		assert.equal(group.render(100), group.render(100));
	}
});

test("多段思考不重复分配消息总 token；空思考不生成空组", () => {
	const component = history(msg([thinking(" "), thinking("甲"), thinking("乙"), text("答复"), thinking("丙")], { usage: { reasoning: 999 } }));
	const groups = nestedGroups(component);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].thinkingFrozen, "甲\n\n乙");
	assert.ok(groups.every((group) => !group.thinkingTokensFrozenExact && group.thinkingTokensFrozen < 999));
	component.updateContent(msg([thinking(""), text("仅正文")]));
	assert.equal(nestedGroups(component).length, 0);
	assert.doesNotMatch(plain(component), /thinking/);
});

test("截断或中断消息先展示历史思考，再保留原生诊断", () => {
	for (const [stopReason, diagnostic] of [["aborted", "Operation aborted"], ["length", "Response was truncated"]]) {
		const component = history(msg([thinking("中断前思考")], { stopReason }));
		const output = plain(component);
		assert.ok(output.indexOf("中断前思考") < output.indexOf(diagnostic));
		assert.match(output, new RegExp(diagnostic));
	}
});

test("重新选择分支或压缩后重建只显示传入消息，不从旧组件串入思考", () => {
	const chat = new Container();
	const old = history(msg([thinking("旧分支"), text("旧正文")]));
	chat.addChild(old);
	chat.clear();
	const current = history(msg([thinking("新分支"), text("新正文")]));
	chat.addChild(current);
	assert.match(plain(chat), /新分支/);
	assert.doesNotMatch(plain(chat), /旧分支/);
	chat.clear();
});

test("历史思考不吞掉 plan/subagent/goal-x 原生工具渲染", () => {
	const chat = new Container();
	for (const name of extension.DEFAULT_NATIVE_TOOLS) {
		chat.addChild(history(msg([thinking(`before-${name}`)])));
		const tool = new ToolExecutionComponent(name, name, {}, {}, {
			name,
			renderResult: () => new Markdown(`原生-${name}`, 0, 0, getMarkdownTheme()),
		} as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: "raw" }], details: undefined, isError: false }, false);
		assert.ok(chat.children.includes(tool));
		assert.match(plain(tool), new RegExp(`原生-${name}`));
	}
	chat.clear();
});

test("实时流式组件在最终帧和 invalidate 后不额外复制历史思考", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	const component = new AssistantMessageComponent() as any;
	chat.addChild(component);
	const source = msg([thinking("实时推理")]);
	component.updateContent(source, true);
	await fake.emit("message_update", { message: source, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
	component.updateContent(source, false);
	await fake.emit("agent_end");
	component.invalidate();
	const output = plain(chat);
	assert.equal(output.split("实时推理").length - 1, 1);
	assert.equal(nestedGroups(component).length, 0);
	chat.clear();
});

test("实时思考锚定正文后重复终帧重建仍只有一个组", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	const component = new AssistantMessageComponent() as any;
	chat.addChild(component);
	let source = msg([thinking("锚定推理")]);
	component.updateContent(source, true);
	await fake.emit("message_update", { message: source, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
	source = msg([thinking("锚定推理"), text("终帧正文")]);
	// 与 pi 一样，扩展事件先于组件更新时也必须能恢复锚点。
	await fake.emit("message_update", { message: source, assistantMessageEvent: { type: "text_delta", contentIndex: 1 } });
	component.updateContent(source, true);
	component.updateContent(source, false);
	await fake.emit("agent_end");
	for (let i = 0; i < 3; i++) {
		component.invalidate();
		component.setExpanded(true);
		assert.equal(plain(chat).split("锚定推理").length - 1, 1);
		assert.equal(nestedGroups(component).length, 1);
	}
	chat.clear();
});

test("/reload 重建窗口中的历史思考在下一实例安装后仍可重画", async () => {
	await fake.emit("session_shutdown", { reason: "reload" });
	const component = history(msg([thinking("重载保留"), text("回复")]));
	assert.match(plain(component), /重载保留/);
	const next = createFakePi();
	const fresh = await import(`../index.ts?reload=${Date.now()}`);
	fresh.default(next.pi as any);
	await next.emit("session_start");
	try {
		component.invalidate();
		component.setExpanded(true);
		assert.equal(plain(component).split("重载保留").length - 1, 1);
		assert.ok(nestedGroups(component).every((group) => group.expanded));
	} finally {
		await next.emit("session_shutdown");
	}
});
