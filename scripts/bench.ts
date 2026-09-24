// 长会话逐帧渲染基准：构造 N 轮“助手回复 + 3 个工具”的对话，测量整棵对话树每帧渲染耗时。
// 用法：npm run bench [-- 轮数...]，默认 100 500 2000。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-ui-bench-"));

const { AssistantMessageComponent, initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container } = await import("@earendil-works/pi-tui");
initTheme("dark");

const WIDTH = 120;
const FRAMES = 20;
const ui = { requestRender() {} };
const reply = (i: number) =>
	`第 ${i} 轮结论：修改了 **配置解析** 与缓存。\n\n- 要点一：${"说明文字 ".repeat(12)}\n- 要点二：\`index.ts\`\n\n\`\`\`ts\nconst value = ${i};\nconsole.log(value);\n\`\`\``;

function buildTranscript(rounds: number): InstanceType<typeof Container> {
	const chat = new Container();
	for (let i = 0; i < rounds; i++) {
		chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [] } as any));
		for (const name of ["read", "grep", "bash"]) {
			const tool = new ToolExecutionComponent(name, `${name}-${i}`, { path: `src/f${i}.ts`, pattern: "x", command: "ls" }, {}, undefined, ui as any, process.cwd());
			chat.addChild(tool);
			tool.updateResult({ content: [{ type: "text", text: "line\n".repeat(20) }], details: undefined, isError: false } as any, false);
		}
		chat.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: reply(i) }] } as any));
	}
	return chat;
}

function measure(chat: InstanceType<typeof Container>): { lines: number; ms: number } {
	let lines = chat.render(WIDTH).length; // 首帧填充缓存，不计入
	const start = performance.now();
	for (let f = 0; f < FRAMES; f++) lines = chat.render(WIDTH).length;
	return { lines, ms: (performance.now() - start) / FRAMES };
}

const rounds = process.argv.slice(2).map(Number).filter((n) => n > 0);
const extension = (await import("../index.ts")).default;
const handlers = new Map<string, Function>();
extension({ on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand() {}, registerTool() {} } as any);
const ctx = { mode: "tui", hasUI: true, ui: { theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t }, setHiddenThinkingLabel() {}, setWidget() {}, notify() {} } };

for (const n of rounds.length ? rounds : [100, 500, 2000]) {
	const native = measure(buildTranscript(n));
	await handlers.get("session_start")!({}, ctx);
	const compact = measure(buildTranscript(n));
	await handlers.get("session_shutdown")!({}, ctx);
	console.log(
		`${n} 轮：原生 ${native.lines} 行 ${native.ms.toFixed(2)}ms/帧；compact-ui ${compact.lines} 行 ${compact.ms.toFixed(2)}ms/帧`,
	);
}
