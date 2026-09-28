import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CONFIG_PATH 在模块加载时确定，必须在导入扩展之前指向临时目录，避免读写用户真实配置。
export const agentDir = mkdtempSync(join(tmpdir(), "compact-ui-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

type Handler = (event: any, ctx: any) => unknown;

export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 最小 ExtensionAPI 替身：记录事件处理器、命令与工具注册。 */
export function createFakePi(theme = plainTheme) {
	const handlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	const renders = { count: 0 };
	const tui = { requestRender: () => renders.count++ };
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
	};
	const ctx = (mode: string) => ({
		mode,
		hasUI: mode === "tui",
		ui: {
			theme,
			setHiddenThinkingLabel() {},
			setWidget(_key: string, factory: unknown) {
				if (typeof factory === "function") factory(tui);
			},
			notify() {},
		},
	});
	const emit = async (name: string, event: any = {}, mode = "tui") => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx(mode));
	};
	return { pi, emit, tools, renders };
}
