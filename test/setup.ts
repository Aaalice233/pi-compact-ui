import { registerHooks } from "node:module";

// pi-coding-agent 自带一份嵌套的 pi-tui。pi 运行时会把扩展里的 "@earendil-works/pi-tui"
// 解析到它自己那一份；测试里照此重定向，否则原型补丁会装到另一份 Container 上。
const piCodingAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui" || specifier.startsWith("@earendil-works/pi-tui/")) {
			return nextResolve(specifier, { ...context, parentURL: piCodingAgentUrl });
		}
		return nextResolve(specifier, context);
	},
});
