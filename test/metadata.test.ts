import "./helpers.ts";
import { createFakePi, plainTheme } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";

initTheme("dark");
const palette: Record<string, string> = { toolDiffAdded: "\x1b[32m", toolDiffRemoved: "\x1b[31m", dim: "\x1b[90m" };
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

test("增减分别使用主题红绿，耗时加括号且紧邻内容", async () => {
	const { chat, group } = await fixture("colors");
	try {
		for (const expanded of [false, true]) {
			group.setExpanded(expanded);
			const output = group.render(80).join("\n");
			assert.match(output, /\x1b\[32m\+1\x1b\[39m/);
			assert.match(output, /\x1b\[31m−2\x1b\[39m/);
			if (expanded) assert.match(stripTerminalSequences(output), /src\/auth\.ts \+1 −2 \(\d+\.\ds\)/);
			else {
				assert.match(stripTerminalSequences(output), /▸ edit ×1 \+1 −2/);
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
		assert.match(heading, /edit ×5 \+19 −43 · 1 失败 · 1 运行中/);
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
	assert.equal(group.render(120).map(stripTerminalSequences).filter((line: string) => line.trim()).join(""), " ▸ edit ×1");
	chat.clear();
});

test("失败的 edit 不把返回的 diff 当作成功增减量", async () => {
	const { chat, group } = await fixture("failed-edit", true);
	try {
		assert.doesNotMatch(group.render(120).join("\n"), /[+−]\d/);
		group.setExpanded(true);
		const output = group.render(120).join("\n");
		assert.match(stripTerminalSequences(output), /修改失败 \(\d+\.\ds\)/);
		assert.doesNotMatch(output, /\x1b\[(?:32|31)m[+−]/);
	} finally { chat.clear(); }
});
