import "./helpers.ts";
import { createFakePi, plainTheme } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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

test("已完成组收起为单行，保留失败数量但隐藏工具与思考原文", () => {
	const component = new CompactExternalGroupComponent(fixture(), plainTheme);
	const lines = component.render(80).map(stripTerminalSequences);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /read×1 bash×1 mcp×1 · 失败1/);
	assert.doesNotMatch(lines[0]!, /思考/, "标题不再占用思考用量");
	assert.doesNotMatch(lines.join("\n"), /断言失败|验证过期|认证\.ts/);
	component.setExpanded(true);
	assert.match(component.render(80).join("\n"), /✗ bash.*断言失败/);
	assert.doesNotMatch(lines.join("\n"), /tools done|tool calling|thinking:/);
});

test("外部组只显示最新待完成调用，结束后自动退为标题", () => {
	const data = fixture();
	data.sealed = false;
	data.thinkingActive = true;
	data.tools[0]!.status = "pending";
	data.tools[2]!.status = "pending";
	const group = new CompactExternalGroupComponent(data, plainTheme);
	assert.equal(group.render(120).length, 2);
	assert.match(group.render(120)[1]!, /mcp.*inspect_actor/);
	assert.doesNotMatch(group.render(120).join("\n"), /验证过期|断言失败/);
	data.tools[2]!.status = "success";
	assert.match(group.render(120)[1]!, /read.*认证/);
	data.tools[0]!.status = "success";
	assert.equal(group.render(120).length, 1, "没有待完成工具时，思考中也不显示原文");
	data.thinkingActive = false; data.sealed = true;
	assert.equal(group.render(120).length, 1);
	assert.match(group.render(120)[0]!, /失败1/);
});

test("纯思考默认只显示入口，点击后仍可查看原文", () => {
	const data = fixture(); data.tools = [];
	const group = new CompactExternalGroupComponent(data, plainTheme);
	assert.deepEqual(group.render(120), [" ▸ 思考记录"]);
	group.setExpanded(true);
	assert.match(group.render(120).join("\n"), /验证过期/);
});

test("运行中的手动展开不跨本轮，封存后的手动展开仍然保留", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	const tools = ["manual-a", "manual-b"].map((id) => {
		const tool = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: "工具返回原文" }], details: undefined, isError: false } as any, false);
		return tool;
	});
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	const rows = () => group.render(120).filter((line: string) => line.trim());
	assert.equal(rows().length, 3, "本块在末尾时逐行显示");
	group.setExpanded(false);
	assert.equal(rows().length, 1, "运行中手动收起");
	// 模拟 Ctrl+O（或点击标题）把它展开。
	group.setExpanded(true);
	assert.deepEqual(rows().map(stripTerminalSequences).slice(1), [
		" │  ✓ read  manual-a.ts",
		" ╰  ✓ read  manual-b.ts",
	]);
	// 本轮正文到达 → 封存；运行中的手动展开不能跨过这一轮。
	const message: any = { role: "assistant", content: [{ type: "text", text: "改好了。" }] };
	await fake.emit("message_start", { message });
	chat.addChild(new AssistantMessageComponent(message));
	await fake.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "改好了。" } });
	assert.equal(group.sealed, true);
	assert.equal(rows().length, 1, "本轮回复出现后必须折回单行，与它之前被 Ctrl+O 展开过无关");
	// 封存后的手动展开（点击 / Ctrl+O 看历史）仍然保留。
	group.setExpanded(true);
	assert.equal(rows().length, 3, "封装后的手动展开保留，否则历史块再也打不开");
	group.setExpanded(false);
	assert.equal(rows().length, 1);
	assert.equal(tools.length, 2);
	await fake.emit("agent_end"); chat.clear();
});

test("调用结束不收起：逐行展开直到本轮回复或运行结束", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	const tools = ["old", "running-a", "running-b"].map((id) => {
		const tool = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool); return tool;
	});
	const finish = (index: number, isError = false) => tools[index]!.updateResult({ content: [{ type: "text", text: "工具返回原文" }], details: undefined, isError }, false);
	finish(0, true);
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	const lines = () => group.render(120).filter((line: string) => line.trim()).map(stripTerminalSequences);
	// 本块逐行显示：已完成的失败行与两条进行中的调用都在屏幕上。
	assert.equal(lines().length, 4);
	assert.match(lines()[0]!, /read×3 · 失败1$/);
	assert.match(lines()[2]!, /running-a\.ts/);
	assert.match(lines()[3]!, /running-b\.ts/);
	finish(2);
	assert.equal(lines().length, 4, "一个调用结束不能让同轮的其他行消失");
	assert.match(lines()[1]!, /old\.ts/);
	finish(1);
	// 关键：本轮调用都结束了、回复还没来，也不能收起来，否则会出现展开/收起的闪动。
	assert.equal(lines().length, 4, "调用全部结束但本轮还未封存时仍然保持展开");
	assert.match(lines()[3]!, /running-b\.ts/);
	await fake.emit("agent_end");
	assert.equal(group.sealed, true);
	assert.equal(lines().length, 1, "本轮回复/运行结束才折回单行");
	assert.match(lines()[0]!, /read×3 · 失败1/);
	assert.doesNotMatch(lines()[0]!, /工具返回原文/);
	chat.clear();
});

test("手动收起约束整个未封存的块，封存后的新块重新自动展开", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	const tool = new ToolExecutionComponent("read", "manual", { path: "manual.ts" }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
	chat.addChild(tool);
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	const rows = () => group.render(120).filter((line: string) => line.trim());
	assert.match(rows()[0], /▾/, "运行中默认逐行显示");
	group.setExpanded(false);
	assert.match(rows()[0], /▸/, "手动收起后本块不再自动展开");
	// 同一个块里继续追加调用，也不能自己弹开。
	tool.updateResult({ content: [{ type: "text", text: "工具返回原文" }], details: undefined, isError: false }, false);
	await fake.emit("tool_execution_end", { toolCallId: "manual" });
	const next = new ToolExecutionComponent("read", "manual-2", { path: "manual-2.ts" }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
	chat.addChild(next);
	await fake.emit("tool_execution_start", { toolCallId: "manual-2", toolName: "read", args: { path: "manual-2.ts" } });
	assert.match(rows()[0], /▸/, "同一块里新增调用不会重新弹开");
	// 封存后新块由新组件接管，恢复自动展开。
	await fake.emit("agent_end");
	assert.match(rows()[0], /▸/);
	await fake.emit("agent_start");
	const fresh = new ToolExecutionComponent("read", "fresh", { path: "fresh.ts" }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
	chat.addChild(fresh);
	await fake.emit("tool_execution_start", { toolCallId: "fresh", toolName: "read", args: { path: "fresh.ts" } });
	const freshGroup = chat.children.filter((child: any) => child.toolName === "group").at(-1) as any;
	assert.notEqual(freshGroup, group, "封存后的调用属于新的块");
	assert.match(freshGroup.render(120).filter((line: string) => line.trim())[0], /▾/, "新块重新自动展开");
	await fake.emit("agent_end"); chat.clear();
});

test("中文、emoji、长工具名在极窄到宽屏都不溢出；耗时紧跟内容不贴右边缘", () => {
	const state = fixture();
	state.tools[0]!.name = "mcp__长工具名称😀_超长后缀";
	const component = new CompactExternalGroupComponent(state, plainTheme);
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		for (const width of [1, 2, 5, 12, 20, 36, 60, 80, 120, 240]) {
			assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `${width}/${expanded}`);
		}
	}
	component.setExpanded(true);
	const timed = component.render(80).filter((line) => /\(\d\.\ds\)$/.test(line));
	assert.equal(timed.length, 3);
	// 耗时紧跟各自内容：列位各不相同，且都离终端右边缘很远；宽终端也不会把它们拉开。
	const starts = timed.map((line) => visibleWidth(line.slice(0, /\(\d\.\ds\)$/.exec(line)!.index)));
	assert.equal(new Set(starts).size, starts.length, "各行耗时各自就近，不做跳行对齐");
	assert.ok(starts.every((start) => start < 70), `耗时不贴右边缘（${starts.join("/")}）`);
	assert.deepEqual(component.render(240).filter((line) => /\(\d\.\ds\)$/.test(line)), timed, "终端变宽不能拉开内容与耗时");
});

test("宽终端下耗时紧跟内容，不填充整行", () => {
	const state = fixture();
	state.tools = [
		{ id: "1", name: "bash", args: { command: "pi --help 2>&1 | head -60" }, status: "success", resultText: "", startedAt: 0, endedAt: 9700 },
		{ id: "2", name: "bash", args: { command: "pi list 2>&1" }, status: "success", resultText: "", startedAt: 0, endedAt: 5000 },
	];
	state.thinking = "";
	const component = new CompactExternalGroupComponent(state, plainTheme);
	assert.deepEqual(component.render(240), [" ▸ bash×2"]);
	component.setExpanded(true);
	assert.deepEqual(component.render(240), [
		" ▾ bash×2",
		" │  ✓ bash  pi --help 2>&1 | head -60 (9.7s)",
		" ╰  ✓ bash  pi list 2>&1 (5.0s)",
	]);
	state.thinking = "检查帮助信息";
	assert.equal(component.render(240)[0], " ▾ bash×2");
	assert.equal(component.render(80)[0], component.render(240)[0]);
});

test("设置中的行数按整数和范围约束，非法值不导致超长渲染", () => {
	const config = resolveConfig({ collapsedMaxLines: -10, expandedToolLines: 1.9, expandedThinkingLines: 1e9 });
	assert.equal(config.expandedThinkingLines, 100);
	assert.equal("collapsedMaxLines" in config, false, "旧折叠行数设置不再使用");
	assert.equal("expandedToolLines" in config, false, "旧返回正文预览设置不再使用");
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
	assert.match(lines.join("\n"), /失败1/);
	assert.doesNotMatch(lines.join("\n"), /失败诊断/);
	assert.equal(lines.filter((line) => line.trim()).length, 1);
	(group as any).setExpanded(true);
	assert.match(group.render(80).join("\n"), /失败诊断/);
	assert.doesNotMatch(group.render(80).join("\n"), /0\.0s/);
	chat.clear();
});

test("一级展开显示完整平铺列表，不解析返回正文或混排多行思考", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	for (let i = 0; i < 20; i++) {
		const tool = new ToolExecutionComponent("read", `list-${i}`, { path: `tool-${i}.ts` }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: `返回正文标记-${i}\n` + "代码或日志\n".repeat(100) }], details: undefined, isError: false }, false);
	}
	await fake.emit("agent_end");
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	group.thinkingFrozen = "思考摘要\n" + "思考后文\n".repeat(100);
	group.setExpanded(true);
	const original = Markdown.prototype.render;
	let parses = 0;
	Markdown.prototype.render = function (width) { parses++; return original.call(this, width); };
	try {
		const lines = group.render(120).map(stripTerminalSequences);
		assert.equal(lines.length, 1 + 1 + 20 + 1, "组前空行、标题、20 个工具、一行思考摘要");
		assert.deepEqual(lines.filter((line: string) => /✓ read/.test(line)).map((line: string) => /tool-(\d+)\.ts/.exec(line)![1]), Array.from({ length: 20 }, (_, i) => String(i)));
		assert.doesNotMatch(lines.join("\n"), /返回正文标记|代码或日志/);
		assert.equal(parses, 0, "展开工具列表不应解析结果或思考 Markdown");
		assert.match(lines.at(-1)!, /╰.*思考摘要/);
		assert.equal(group.render(120), group.render(120));
	} finally { Markdown.prototype.render = original; chat.clear(); }
});

test("长工具摘要只在信息类别之间使用分隔点，失败数量保持真实", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	for (const [name, count] of [["mcpScript", 14], ["mcp", 13], ["grep", 3], ["find", 3], ["read", 7], ["write", 3], ["edit", 3], ["bash", 8]] as const) {
		for (let i = 0; i < count; i++) {
			const tool = new ToolExecutionComponent(name, `${name}-${i}`, {}, {}, { name } as any, { requestRender() {} } as any, process.cwd());
			chat.addChild(tool);
			const diff = name === "edit" && i < 2 ? (i === 0 ? "+new\n".repeat(8) : "-old\n".repeat(3)) : undefined;
			tool.updateResult({ content: [{ type: "text", text: "结果" }], details: diff ? { diff } : undefined, isError: name === "bash" && i < 2 }, false);
		}
	}
	await fake.emit("agent_end");
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	try {
		const heading = group.render(240).map(stripTerminalSequences).filter((line: string) => line.trim());
		assert.deepEqual(heading, [" ▸ mcpScript×14 mcp×13 grep×3 find×3 read×7 write×3 edit×3 bash×8 · +8 −3 · 失败2"]);
		group.setExpanded(true);
		assert.equal(stripTerminalSequences(group.render(240)[1]), heading[0].replace("▸", "▾"));
	} finally { chat.clear(); }
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
