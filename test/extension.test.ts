import "./helpers.ts";
import { agentDir, createFakePi } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { AssistantMessageComponent, getMarkdownTheme, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

initTheme("dark");
const extension = await import("../index.ts");
const { DEFAULT_NATIVE_TOOLS, createToolMatcher, resolveConfig } = extension;

const originalAddChild = Container.prototype.addChild;
const ui = { requestRender() {} };

function tool(name: string, id: string, definition: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(name, id, { path: `${id}.ts` }, {}, { name, ...definition } as any, ui as any, process.cwd());
}

function finish(component: ToolExecutionComponent, text = "done") {
	component.updateResult({ content: [{ type: "text", text }], details: undefined, isError: false } as any, false);
}

function assistant(text = "") {
	return new AssistantMessageComponent({ role: "assistant", content: text ? [{ type: "text", text }] : [] } as any);
}

describe("配置解析", () => {
	test("缺省时使用默认原生名单", () => {
		const config = resolveConfig(undefined);
		assert.deepEqual(config.nativeTools, [...DEFAULT_NATIVE_TOOLS]);
		assert.equal(config.expandedThinkingLines, 10);
	});

	test("nativeTools 整体替换默认值，非法项被丢弃", () => {
		const config = resolveConfig({ nativeTools: ["subagent", 3, "", "mcp__*"], expandedThinkingLines: "x" });
		assert.deepEqual(config.nativeTools, ["subagent", "mcp__*"]);
		assert.equal(config.expandedThinkingLines, 10);
	});

	test("名单支持 * 通配符并按字面匹配其余字符", () => {
		const match = createToolMatcher(["mcp__*", "a.b"]);
		assert.equal(match("mcp__monolith"), true);
		assert.equal(match("mcp"), false);
		assert.equal(match("a.b"), true);
		assert.equal(match("axb"), false);
	});
});

describe("非交互模式", () => {
	test("print/json/子代理进程不注册工具、不改原型", async () => {
		const fake = createFakePi();
		extension.default(fake.pi as any);
		await fake.emit("session_start", {}, "json");
		assert.deepEqual(fake.tools, [], "不应覆盖内置工具");
		assert.equal(Container.prototype.addChild, originalAddChild);
	});
});

describe("交互模式", () => {
	let fake: ReturnType<typeof createFakePi>;

	before(async () => {
		fake = createFakePi();
		extension.default(fake.pi as any);
		await fake.emit("session_start");
	});

	after(async () => {
		await fake.emit("session_shutdown");
	});

	beforeEach(async () => {
		await fake.emit("agent_end");
		await fake.emit("agent_start");
	});

	test("不覆盖内置工具，首次运行写出配置文件", () => {
		assert.deepEqual(fake.tools, []);
		const saved = JSON.parse(readFileSync(join(agentDir, "compact-ui.json"), "utf-8"));
		assert.deepEqual(saved.nativeTools, [...DEFAULT_NATIVE_TOOLS]);
	});

	test("普通工具并入折叠组，名单内工具保持原生渲染并切分组", () => {
		const chat = new Container();
		chat.addChild(assistant());
		const read = tool("read", "r1");
		chat.addChild(read);
		const plan = tool("plan_mode_complete", "p1", {
			renderResult: () => new Markdown("# Plan\n\n1. step", 0, 0, getMarkdownTheme()),
		});
		chat.addChild(plan);
		const grep = tool("grep", "g1");
		chat.addChild(grep);

		const kinds = chat.children.map((child) => child.constructor.name);
		assert.equal(kinds.filter((name) => name === "ToolGroupComponent").length, 2, kinds.join(","));
		assert.ok(chat.children.includes(plan), "计划工具应直接留在对话容器中");
		assert.ok(!chat.children.includes(read) && !chat.children.includes(grep));

		finish(plan, "plan text");
		const rendered = plan.render(80).join("\n");
		assert.match(rendered, /Plan/, "应使用工具自带的 renderResult");

		const groups = chat.children.filter((child) => child.constructor.name === "ToolGroupComponent") as any[];
		assert.equal(groups[0].sealed, true, "原生工具之前的组应被封存");
		assert.deepEqual(groups[0].children, [read]);
		assert.deepEqual(groups[1].children, [grep]);
	});

	test("静态组的渲染结果被缓存，状态变化后刷新", () => {
		const chat = new Container();
		chat.addChild(assistant());
		const read = tool("read", "r2");
		chat.addChild(read);
		const group = chat.children.find((child) => child.constructor.name === "ToolGroupComponent") as any;

		finish(read);
		const first = group.render(80);
		assert.equal(group.render(80), first, "未变化时应返回同一数组");
		group.setExpanded(true);
		const expanded = group.render(80);
		assert.notEqual(expanded, first);
		assert.match(expanded.join("\n"), /read.*r2\.ts/);
		assert.doesNotMatch(expanded.join("\n"), /done/, "一级展开不显示返回正文");
	});

	test("组失效不级联到组内工具，避免重跑第三方渲染器", () => {
		let calls = 0;
		const chat = new Container();
		chat.addChild(assistant());
		const custom = tool("web_search", "w1", {
			renderResult: () => {
				calls++;
				return new Text("result", 0, 0);
			},
		});
		chat.addChild(custom);
		finish(custom);
		const before = calls;
		const group = chat.children.find((child) => child.constructor.name === "ToolGroupComponent") as any;
		for (let i = 0; i < 50; i++) group.invalidate();
		group.setExpanded(true);
		assert.equal(calls, before);
	});

	test("助手 Markdown 规范化结果按内容缓存", () => {
		const chat = new Container();
		const message = assistant("hello **world**\n\n```ts\nconst a = 1;\n```");
		chat.addChild(message);
		const first = message.render(60);
		const second = message.render(60);
		const markdown = (message as any).contentContainer.children.find((child: any) => child instanceof Markdown);
		assert.ok(markdown, "应找到可见文本 Markdown");
		assert.equal(markdown.render(60), markdown.render(60), "同一内容与宽度应复用结果数组");
		assert.deepEqual(first, second);
	});

	test("运行结束时未完成的工具标记为中断，不再驱动动画", async () => {
		const chat = new Container();
		chat.addChild(assistant());
		const bash = tool("bash", "b1");
		chat.addChild(bash);
		const group = chat.children.find((child) => child.constructor.name === "ToolGroupComponent") as any;
		assert.equal(group.needsAnimation(), true);
		await fake.emit("agent_end");
		assert.equal(group.needsAnimation(), false);
		assert.match(group.render(80).join("\n"), /bash×1 · 失败1/);
		group.setExpanded(true);
		assert.match(group.render(80).join("\n"), /✗ bash.*已中断/);
	});

	test("修改配置文件后无需重载即生效", async () => {
		const path = join(agentDir, "compact-ui.json");
		const saved = JSON.parse(readFileSync(path, "utf-8"));
		writeFileSync(path, JSON.stringify({ ...saved, nativeTools: ["read"] }));
		await new Promise((resolve) => setTimeout(resolve, 600));

		const chat = new Container();
		chat.addChild(assistant());
		const read = tool("read", "r3");
		const plan = tool("plan_mode_complete", "p3");
		chat.addChild(read);
		chat.addChild(plan);
		assert.ok(chat.children.includes(read), "read 已在名单内，应保持原生");
		assert.ok(!chat.children.includes(plan), "plan 已移出名单，应被折叠");
		writeFileSync(path, JSON.stringify(saved));
		await new Promise((resolve) => setTimeout(resolve, 600));
	});
});

describe("卸载", () => {
	test("/reload 时保留补丁，pi 在新实例启动前重建的历史仍按折叠样式显示", async () => {
		const fake = createFakePi();
		extension.default(fake.pi as any);
		await fake.emit("session_start");
		await fake.emit("session_shutdown", { reason: "reload" });
		assert.notEqual(Container.prototype.addChild, originalAddChild);

		const next = createFakePi();
		extension.default(next.pi as any);
		await next.emit("session_start");
		await next.emit("session_shutdown", { reason: "quit" });
		assert.equal(Container.prototype.addChild, originalAddChild, "多次重装后仍能还原到最初的原型");
	});
	test("session_shutdown 还原全部原型补丁", async () => {
		const fake = createFakePi();
		extension.default(fake.pi as any);
		await fake.emit("session_start");
		assert.notEqual(Container.prototype.addChild, originalAddChild);
		await fake.emit("session_shutdown");
		assert.equal(Container.prototype.addChild, originalAddChild);
	});
});
