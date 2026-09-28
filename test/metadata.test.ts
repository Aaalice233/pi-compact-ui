import "./helpers.ts";
import { createFakePi, plainTheme } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";

initTheme("dark");
const palette: Record<string, string> = { toolDiffAdded: "\x1b[32m", toolDiffRemoved: "\x1b[31m", dim: "\x1b[90m", muted: "\x1b[37m", error: "\x1b[35m" };
const fake = createFakePi({ ...plainTheme, fg: (color, text) => palette[color] ? `${palette[color]}${text}\x1b[39m` : text });
before(async () => { extension(fake.pi as any); await fake.emit("session_start"); });
after(async () => { await fake.emit("session_shutdown"); });

async function fixture(id: string, isError = false) {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	await fake.emit("tool_execution_start", { toolCallId: id });
	const tool = new ToolExecutionComponent("edit", id, { path: "src/auth.ts" }, {}, { name: "edit" } as any, { requestRender() {} } as any, process.cwd());
	chat.addChild(tool);
	tool.updateResult({ content: [{ type: "text", text: isError ? "修改失败" : "修改成功" }], details: { diff: "@@ -1,2 +1 @@\n-old one\n-old two\n+new line\n context" }, isError }, false);
	await fake.emit("tool_execution_end", { toolCallId: id });
	await fake.emit("agent_end");
	return { chat, group: chat.children.find((child: any) => child.toolName === "group") as any };
}

test("增减分别使用主题红绿，耗时右对齐成列", async () => {
	const { chat, group } = await fixture("colors");
	try {
		for (const expanded of [false, true]) {
			group.setExpanded(expanded);
			const output = group.render(80).join("\n");
			assert.match(output, /\x1b\[32m\+1\x1b\[39m/);
			assert.match(output, /\x1b\[31m−2\x1b\[39m/);
			if (expanded) assert.match(stripTerminalSequences(output), /src\/auth\.ts \+1 −2$/);
			else {
				assert.match(stripTerminalSequences(output), /▸ edit×1 · \+1 −2/);
				assert.doesNotMatch(stripTerminalSequences(output), /src\/auth\.ts/);
			}
			assert.equal(group.render(80), group.render(80), "静态渲染继续使用缓存");
			for (const width of [1, 12, 36, 80, 240]) assert.ok(group.render(width).every((line: string) => visibleWidth(line) <= width));
		}
		palette.toolDiffAdded = "\x1b[92m";
		group.invalidate();
		const recolored = group.render(80).join("\n");
		assert.match(recolored, /\x1b\[92m\+1/);
		assert.doesNotMatch(recolored, /\x1b\[32m\+1/);
	} finally { palette.toolDiffAdded = "\x1b[32m"; chat.clear(); }
});

test("折叠标题的失败计数用主题灰色，红色只留给展开后的 ✗ 与错误正文", async () => {
	const { chat, group } = await fixture("failed-color", true);
	try {
		assert.match(group.render(80).join("\n"), /\x1b\[37m失败1\x1b\[39m/);
		assert.doesNotMatch(group.render(80).join("\n"), /\x1b\[35m失败/);
	} finally { chat.clear(); }
});

test("毫秒级调用不显示 0.0s，也不影响其他行的排版", async () => {
	const now = Date.now;
	try {
		Date.now = () => 5000;
		await fake.emit("agent_start");
		const chat = new Container();
		chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
		const build = (id: string) => {
			const component = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, { name: "read" } as any, { requestRender() {} } as any, process.cwd());
			chat.addChild(component);
			return component;
		};
		await fake.emit("tool_execution_start", { toolCallId: "instant" });
		build("instant").updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false } as any, false);
		await fake.emit("tool_execution_end", { toolCallId: "instant" });
		await fake.emit("tool_execution_start", { toolCallId: "slow" });
		const slow = build("slow");
		Date.now = () => 6200;
		slow.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false } as any, false);
		await fake.emit("tool_execution_end", { toolCallId: "slow" });
		const group = chat.children.find((child: any) => child.toolName === "group") as any;
		group.setExpanded(true);
		const lines = group.render(100).map(stripTerminalSequences).filter((line: string) => line.trim());
		assert.match(lines[1]!, /instant\.ts$/, "不足 0.1s 不显示耗时");
		assert.match(lines[2]!, /slow\.ts \(1\.2s\)$/, "能计时的调用在正文后括注耗时");
		chat.clear();
	} finally {
		Date.now = now;
		await fake.emit("agent_end");
	}
});

test("结果摘要与耗时紧跟各行内容，不被最长的一行拖远", async () => {
	const now = Date.now;
	const longCommand = `pwsh -NoProfile -Command '$ErrorActionPreference = "Stop"; Get-Location; git status --short; Get-CimInstance Win32_Process | Select-Object -First 5'`;
	try {
		Date.now = () => 1000;
		await fake.emit("agent_start");
		const chat = new Container();
		chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
		const build = (name: string, id: string, args: any) => {
			const component = new ToolExecutionComponent(name, id, args, {}, { name } as any, { requestRender() {} } as any, process.cwd());
			chat.addChild(component);
			return component;
		};
		const ids = ["edit-a", "edit-b", "read-a", "bash-long"];
		await fake.emit("tool_execution_start", { toolCallId: ids[0] });
		const edit = build("edit", ids[0]!, { path: "src/auth.ts" });
		await fake.emit("tool_execution_start", { toolCallId: ids[1] });
		const wide = build("edit", ids[1]!, { path: "src/user.ts" });
		await fake.emit("tool_execution_start", { toolCallId: ids[2] });
		const read = build("read", ids[2]!, { path: "src/session.ts" });
		await fake.emit("tool_execution_start", { toolCallId: ids[3] });
		const long = build("bash", ids[3]!, { command: longCommand });
		Date.now = () => 2200;
		edit.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: "@@ -1,1 +1,1 @@\n-old\n+new\n" }, isError: false } as any, false);
		wide.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: `@@ -1,2 +1,10 @@\n${"+added\n".repeat(10)}${"-gone\n".repeat(2)}` }, isError: false } as any, false);
		read.updateResult({ content: [{ type: "text", text: "ok" }], details: undefined, isError: false } as any, false);
		long.updateResult({ content: [{ type: "text", text: "ok" }], details: undefined, isError: false } as any, false);
		for (const id of ids) await fake.emit("tool_execution_end", { toolCallId: id });
		const group = chat.children.find((child: any) => child.toolName === "group") as any;
		const toolRows = (width: number) => group.render(width).map(stripTerminalSequences).filter((line: string) => line.trim()).slice(1);
		const rows = toolRows(160);
		const timeStart = (row: string) => visibleWidth(row.slice(0, row.lastIndexOf(" ") + 1));
		assert.match(rows[0]!, /src\/auth\.ts \+1 −1 \(1\.2s\)$/, "增减与耗时都紧跟内容");
		assert.match(rows[1]!, /src\/user\.ts \+10 −2 \(1\.2s\)$/);
		assert.match(rows[2]!, /src\/session\.ts \(1\.2s\)$/, "没有摘要的行也紧跟内容");
		// 关键：一条很长的命令不能把其他行的耗时拖到屏幕右侧。
		assert.ok(timeStart(rows[3]!) > 100, "长命令自己的耗时跟在自己的内容后面");
		for (const short of rows.slice(0, 3)) assert.ok(timeStart(short) < 40, `短行耗时不跨屏：实际第 ${timeStart(short)} 列`);
		assert.notEqual(timeStart(rows[2]!), timeStart(rows[0]!), "没有共享列，各行各自就近");
		// 短行不受终端宽度影响（长命令行在更宽终端上本来就能多显示内容，不参与比较）。
		assert.deepEqual(toolRows(240).slice(0, 3), rows.slice(0, 3), "终端变宽不能把短行的耗时拉开");
		chat.clear();
	} finally {
		Date.now = now;
		await fake.emit("agent_end");
	}
});

test("长命令只受行宽限制，不再被固定字符数提前截断", async () => {
	const now = Date.now;
	const command = 'cd "C:/Users/Administrator/.pi/agent/git/github.com/Aaalice233/pi-compact-ui" && git add -A && git status --short && git log --oneline -3';
	try {
		Date.now = () => 1000;
		await fake.emit("agent_start");
		const chat = new Container();
		chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
		await fake.emit("tool_execution_start", { toolCallId: "long" });
		const tool = new ToolExecutionComponent("bash", "long", { command }, {}, { name: "bash" } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool);
		Date.now = () => 2500;
		tool.updateResult({ content: [{ type: "text", text: "ok" }], details: undefined, isError: false } as any, false);
		await fake.emit("tool_execution_end", { toolCallId: "long" });
		const group = chat.children.find((child: any) => child.toolName === "group") as any;
		const wide = group.render(200).map(stripTerminalSequences).filter((line: string) => line.trim())[1]!;
		assert.ok(wide.includes(`git status --short`), "宽终端下命令应完整显示");
		assert.ok(wide.includes(command.slice(60, 80)), "超过 60 字符的部分不能被固定上限截掉");
		assert.doesNotMatch(wide, /…/);
		const narrow = group.render(70).map(stripTerminalSequences).filter((line: string) => line.trim())[1]!;
		assert.match(narrow, /\(1\.5s\)$/);
		assert.ok(visibleWidth(narrow) <= 70, "窄终端仍然不溢出");
		assert.ok(narrow.length < wide.length, "窄终端仍然按行宽截断");
		chat.clear();
	} finally {
		Date.now = now;
		await fake.emit("agent_end");
	}
});

test("折叠标题累计多个成功编辑，排除失败、进行中和未知 diff", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	const records = [
		{ added: 7, removed: 13 }, { added: 12, removed: 30 },
		{ added: 99, removed: 99, isError: true }, { added: 99, removed: 99, partial: true },
		{ added: 0, removed: 0, unknown: true },
	];
	for (const [i, record] of records.entries()) {
		const tool = new ToolExecutionComponent("edit", `sum-${i}`, { path: `file${i}.ts` }, {}, { name: "edit" } as any, { requestRender() {} } as any, process.cwd());
		chat.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: "编辑结果" }], details: record.unknown ? undefined : {
			diff: "+added\n".repeat(record.added) + "-removed\n".repeat(record.removed),
		}, isError: !!record.isError }, !!record.partial);
	}
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	try {
		const heading = group.render(160).map(stripTerminalSequences).find((line: string) => line.trim())!;
		assert.match(heading, /edit×5 · \+19 −43 · 失败1$/);
		assert.doesNotMatch(heading, /[+−](99|118|142|217|241)/);
		await fake.emit("agent_end");
		assert.equal(group.needsAnimation(), false, "运行结束后，部分结果也应标为中断并停止动画");
		const completed = group.render(160).filter((line: string) => stripTerminalSequences(line).trim());
		assert.equal(completed.length, 1);
		assert.match(completed[0], /\x1b\[32m\+19\x1b\[39m/);
		assert.match(completed[0], /\x1b\[31m−43\x1b\[39m/);
	} finally { chat.clear(); }
});

test("没有实际 diff 的成功编辑不显示伪造的零增减", async () => {
	await fake.emit("agent_start");
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
	const tool = new ToolExecutionComponent("edit", "unknown", { path: "unknown.ts" }, {}, { name: "edit" } as any, { requestRender() {} } as any, process.cwd());
	chat.addChild(tool);
	tool.updateResult({ content: [{ type: "text", text: "修改成功" }], details: undefined, isError: false }, false);
	await fake.emit("agent_end");
	const group = chat.children.find((child: any) => child.toolName === "group") as any;
	assert.equal(group.render(120).map(stripTerminalSequences).filter((line: string) => line.trim()).join(""), " ▸ edit×1");
	chat.clear();
});

test("失败的 edit 不把返回的 diff 当作成功增减量", async () => {
	const { chat, group } = await fixture("failed-edit", true);
	try {
		assert.doesNotMatch(group.render(120).join("\n"), /[+−]\d/);
		group.setExpanded(true);
		const output = group.render(120).join("\n");
		assert.match(stripTerminalSequences(output), /修改失败$/);
		assert.doesNotMatch(output, /\x1b\[(?:32|31)m[+−]/);
	} finally { chat.clear(); }
});
