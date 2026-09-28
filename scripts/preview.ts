// Render the actual exported component, not a hand-authored mockup. No session or user config writes.
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { CompactExternalGroupComponent, type CompactExternalGroup } from "../index.ts";
const themes = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
for (const name of ["dark", "light"]) {
	initTheme(name);
	for (const width of [80, 36]) {
		const state: CompactExternalGroup = {
			sealed: true, thinkingActive: false, thinking: "验证过期会话分支；失败项需要重新检查。", thinkingTokens: 1200, thinkingTokensExact: true,
			tools: [
				{ id: "a", name: "read", args: { path: "src/用户/认证.ts" }, status: "success", resultText: "读取认证模块。", startedAt: 0, endedAt: 100 },
				{ id: "b", name: "bash", args: { command: "npm test" }, status: "error", resultText: "断言失败：会话未过期\n预期 expired，实际 active。", startedAt: 100, endedAt: 3300 },
				{ id: "c", name: "mcp", args: { tool: "inspect_actor" }, status: "success", resultText: "检查完成。", startedAt: 3400, endedAt: 3500 },
			],
		};
		const view = new CompactExternalGroupComponent(state, themes.getThemeByName(name));
		for (const expanded of [false, true]) {
			view.setExpanded(expanded);
			console.log(`\n${name} / ${width} 列 / ${expanded ? "展开" : "折叠"}`);
			console.log(view.render(width).map((row) => process.argv.includes("--plain") ? stripTerminalSequences(row) : row).join("\n"));
		}
	}
}
