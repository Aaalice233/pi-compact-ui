import "./helpers.ts";
import { createFakePi, plainTheme } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import extension, { CompactExternalGroupComponent, resolveConfig, type CompactExternalGroup } from "../index.ts";

initTheme("dark");
const fake = createFakePi();
before(async () => { extension(fake.pi as any); await fake.emit("session_start"); });
after(async () => { await fake.emit("session_shutdown"); });

function fixture(): CompactExternalGroup {
	return {
		sealed: true, thinkingActive: false, thinking: "验证过期会话分支；失败项需要重新检查。", thinkingTokens: 1200, thinkingTokensExact: true,
		tools: [
			{ id: "1", name: "read", args: { path: "src/用户/认证.ts" }, status: "success", resultText: "已读取源文件", startedAt: 0, endedAt: 100 },
			{ id: "2", name: "bash", args: { command: "npm test" }, status: "error", resultText: "断言失败：会话未过期", startedAt: 100, endedAt: 3300 },
			{ id: "3", name: "mcp", args: { tool: "inspect_actor" }, status: "success", resultText: "检查完成", startedAt: 3400, endedAt: 3500 },
		],
	};
}

test("折叠严格三行，失败项不被较新的成功项掩盖", () => {
	const component = new CompactExternalGroupComponent(fixture(), plainTheme);
	const lines = component.render(80).map(stripTerminalSequences);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /3 个工具 · 1 失败/);
	assert.match(lines[0]!, /思考 1.2K/);
	assert.match(lines[1]!, /✗ bash.*断言失败/);
	assert.match(lines[2]!, /╰.*验证过期/);
	assert.doesNotMatch(lines.join("\n"), /tools done|tool calling|thinking:/);
});

test("中文、emoji、长工具名在极窄到宽屏都不溢出；耗时紧跟内容", () => {
	const state = fixture();
	state.tools[0]!.name = "mcp__长工具名称😀_超长后缀";
	const component = new CompactExternalGroupComponent(state, plainTheme);
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		for (const width of [1, 2, 5, 12, 20, 36, 60, 80, 120, 240]) {
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `${width}/${expanded}`);
		}
	}
	const timed = component.render(80).filter((line) => /\d\.\ds$/.test(line));
	assert.equal(timed.length, 3);
	assert.ok(timed.every((line) => /\S · \d\.\ds$/.test(line)));
	assert.deepEqual(component.render(240).filter((line) => /\d\.\ds$/.test(line)), timed, "终端变宽不能拉开内容与耗时");
});

test("宽终端的标题 token 和工具耗时就近显示，不填充整行", () => {
	const state = fixture();
	state.tools = [
		{ id: "1", name: "bash", args: { command: "pi --help 2>&1 | head -60" }, status: "success", resultText: "", startedAt: 0, endedAt: 9700 },
		{ id: "2", name: "bash", args: { command: "pi list 2>&1" }, status: "success", resultText: "", startedAt: 0, endedAt: 5000 },
	];
	state.thinking = "";
	const component = new CompactExternalGroupComponent(state, plainTheme);
	assert.deepEqual(component.render(240), [
		" ▸ 2 个工具",
		" │  ✓ bash  pi --help 2>&1 | head -60 · 9.7s",
		" ╰  ✓ bash  pi list 2>&1 · 5.0s",
	]);
	state.thinking = "检查帮助信息";
	assert.equal(component.render(240)[0], " ▸ 2 个工具 · 思考 1.2K");
	assert.equal(component.render(80)[0], component.render(240)[0]);
});

test("设置中的行数按整数和范围约束，非法值不导致超长渲染", () => {
	const config = resolveConfig({ collapsedMaxLines: -10, expandedToolLines: 1.9, expandedThinkingLines: 1e9 });
	assert.deepEqual([config.collapsedMaxLines, config.expandedToolLines, config.expandedThinkingLines], [2, 1, 100]);
});

test("主会话与外部视图保持失败语义，静态缓存不再执行渲染器", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	for (const [name, error] of [["bash", true], ["read", false]] as const) {
		const component = new ToolExecutionComponent(name, name, { path: "src/auth.ts", command: "npm test" }, {}, { name } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(component);
		component.updateResult({ content: [{ type: "text", text: error ? "失败诊断" : "读取成功" }], details: undefined, isError: error }, false);
	}
	await fake.emit("agent_end");
	const group = chat.children.find((child) => (child as any).toolName === "group")!;
	const lines = group.render(80);
	assert.equal(group.render(80), lines);
	assert.match(lines.join("\n"), /1 失败/);
	assert.match(lines.join("\n"), /失败诊断/);
	assert.doesNotMatch(lines.join("\n"), /0\.0s/);
	chat.clear();
});

test("主题失效后颜色重新计算，静态内容保持一致", () => {
	let tag = "dark";
	const theme = { ...plainTheme, fg: (_color: string, text: string) => `[${tag}]${text}` };
	const component = new CompactExternalGroupComponent(fixture(), theme);
	assert.match(component.render(120).join("\n"), /\[dark\]/);
	tag = "light";
	component.invalidate();
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /\[light\]/);
	assert.doesNotMatch(rendered, /\[dark\]/);
});
