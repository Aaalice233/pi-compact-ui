import "./helpers.ts";
import { createFakePi } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
// Deliberately import once: in-process SDK sessions may share this module, unlike subprocess agents.
import extension from "../index.ts";

initTheme("dark");
const plain = (component: any) => component.render(120).map(stripTerminalSequences).join("\n");

async function setup(mode: string) {
	const parent = createFakePi();
	const child = createFakePi();
	extension(parent.pi as any);
	extension(child.pi as any);
	await parent.emit("session_start");
	await parent.emit("agent_start");
	await child.emit("session_start", {}, mode);
	const chat = new Container();
	const assistant = new AssistantMessageComponent();
	chat.addChild(assistant);
	const tool = new ToolExecutionComponent("bash", "shared-call-id", { command: "parent-running" }, {}, { name: "bash" } as any, { requestRender() {} } as any, process.cwd()) as any;
	chat.addChild(tool);
	const group = chat.children.find((component: any) => component.toolName === "group") as any;
	assert.ok(group);
	return { parent, child, chat, assistant, tool, group, cleanup: async () => {
		await child.emit("session_shutdown", {}, mode);
		await parent.emit("agent_end");
		chat.clear();
		await parent.emit("session_shutdown", { reason: "quit" });
	} };
}

for (const mode of ["print", "json", "rpc"]) {
	test(`同进程 ${mode} 子会话结束不应把主会话工具标为失败`, async () => {
		const h = await setup(mode);
		try {
			assert.match(plain(h.group), /· bash  parent-running/, "父会话的进行中调用仍然可见");
			await h.child.emit("agent_end", {}, mode);
			assert.equal(h.tool._groupInterrupted, undefined, "子会话不能中断父会话的工具");
			assert.equal(h.group.sealed, false, "子会话不能封存父会话的组");
			assert.equal(h.group.needsAnimation(), true);
			assert.match(plain(h.group), /parent-running/);
			assert.doesNotMatch(plain(h.group), /失败|已中断/);
			// Only the parent ending can mark its own still-pending tool interrupted.
			await h.parent.emit("agent_end");
			assert.equal(h.tool._groupInterrupted, true);
			assert.equal(h.group.needsAnimation(), false);
			assert.match(plain(h.group), /失败1/);
		} finally { await h.cleanup(); }
	});

	test(`共享同一处理器的 ${mode} 事件也不能关闭主界面`, async () => {
		const h = await setup(mode);
		try {
			const patched = Container.prototype.addChild;
			const before = h.parent.renders.count;
			h.group.render(120);
			// Model a reused extension instance/ResourceLoader, not just two factories importing a module.
			await h.parent.emit("session_start", {}, mode);
			await h.parent.emit("agent_start", {}, mode);
			await h.parent.emit("agent_end", {}, mode);
			await h.parent.emit("session_shutdown", {}, mode);
			assert.equal(h.tool._groupInterrupted, undefined);
			assert.equal(h.group.sealed, false);
			assert.equal(Container.prototype.addChild, patched);
			await new Promise((resolve) => setTimeout(resolve, 180));
			assert.ok(h.parent.renders.count > before);
			await h.parent.emit("agent_end");
			assert.equal(h.tool._groupInterrupted, true, "真正的主会话事件仍有效");
		} finally { await h.cleanup(); }
	});
}

test("子会话的运行、消息与思考事件不能改写主会话思考或正文边界", async () => {
	const h = await setup("print");
	try {
		const message = { role: "assistant", content: [{ type: "thinking", thinking: "主会话思考" }] };
		await h.parent.emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
		h.group.setExpanded(true);
		assert.match(plain(h.group), /主会话思考/);
		await h.child.emit("agent_start", {}, "print");
		await h.child.emit("message_start", { message: { role: "user", content: "子问题" } }, "print");
		await h.child.emit("message_start", { message: { role: "assistant", content: [] } }, "print");
		await h.child.emit("message_update", {
			message: { role: "assistant", content: [{ type: "thinking", thinking: "子会话私有思考" }] },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		}, "print");
		await h.child.emit("message_update", {
			message: { role: "assistant", content: [{ type: "text", text: "子会话正文" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
		}, "print");
		assert.equal(h.group.sealed, false);
		assert.match(plain(h.group), /主会话思考/);
		assert.doesNotMatch(plain(h.chat), /子会话私有思考|子会话正文/);
		await h.parent.emit("message_update", {
			message: { role: "assistant", content: [{ type: "thinking", thinking: "主会话继续思考" }] },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		assert.match(plain(h.group), /主会话继续思考/);
	} finally { await h.cleanup(); }
});

test("同名工具调用 ID 也不能让子会话覆盖主会话计时", async () => {
	const h = await setup("print");
	const now = Date.now;
	try {
		Date.now = () => 1000;
		await h.parent.emit("tool_execution_start", { toolCallId: "shared-call-id" });
		Date.now = () => 9000;
		await h.child.emit("tool_execution_start", { toolCallId: "shared-call-id" }, "print");
		Date.now = () => 10000;
		assert.match(plain(h.group), /\(9\.0s\)$/);
		await h.child.emit("tool_execution_end", { toolCallId: "shared-call-id" }, "print");
		assert.equal(h.tool._groupEndAt, undefined);
		Date.now = () => 11000;
		assert.match(plain(h.group), /\(10\.0s\)$/);
	} finally { Date.now = now; await h.cleanup(); }
});

test("子会话 shutdown 不取消主界面动画定时器或原型补丁", async () => {
	const h = await setup("print");
	try {
		const patched = Container.prototype.addChild;
		const before = h.parent.renders.count;
		h.group.render(120); // Schedules the actual 100 ms animation tick.
		await h.child.emit("session_shutdown", {}, "print");
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.equal(Container.prototype.addChild, patched);
		assert.ok(h.parent.renders.count > before, "子会话结束后主界面仍能刷新");
		assert.equal(h.tool._groupInterrupted, undefined);
	} finally { await h.cleanup(); }
});

test("已关闭的旧 TUI 实例不能用迟到事件中断新实例", async () => {
	const stale = createFakePi();
	extension(stale.pi as any);
	await stale.emit("session_start");
	await stale.emit("session_shutdown", { reason: "reload" });
	const h = await setup("print");
	try {
		await stale.emit("agent_start");
		await stale.emit("agent_end");
		assert.equal(h.tool._groupInterrupted, undefined);
		assert.equal(h.group.sealed, false);
		assert.match(plain(h.group), /· bash  parent-running/, "新实例的进行中调用不受旧实例事件影响");
	} finally { await h.cleanup(); }
});
