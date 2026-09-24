<div align="center">

# compact-ui

### A quiet, structured home for Pi's reasoning and tool calls

![Pi Extension](https://img.shields.io/badge/Pi-Extension-7C3AED?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TUI](https://img.shields.io/badge/UI-Compact_Tree-0F172A?style=flat-square)

</div>


> [!IMPORTANT]
> 这是 [pi-compact-ui](https://www.npmjs.com/package/pi-compact-ui) 0.1.3 的个人 fork，
> 通过 Git 安装：`pi install git:github.com/Aaalice233/pi-compact-ui`。

## Fork 改动

| 问题 | 原因 | 处理 |
|---|---|---|
| plan-mode 提交的计划只剩一行 | 所有工具都被收进折叠组，工具自带的 `renderResult` 不再运行 | 新增 `nativeTools` 名单，名单内工具保持原生显示并切分前后组 |
| 子代理看不到实时进度 | 同上，`subagent` 的进度渲染被折叠组替代 | 默认列入 `nativeTools` |
| goal-x 待确认目标看不全，续跑回合计时错误 | 草案全文在 `propose_goal_draft` 的 `renderCall` 里；goal-x 续跑用隐藏的 custom 消息开新回合，原版只认 user 消息 | 目标相关 4 个工具列入名单；回合边界改为 `agent_start` |
| 模型看到的内置工具说明被替换 | 原版重新注册 read/bash 等 7 个工具，说明变成占位文字，丢失 promptGuidelines、`shellPath` 等设置，子代理进程同样受影响 | 不再注册任何工具；补丁只在 TUI 会话安装，关闭会话时还原 |
| 长会话输出和打字明显卡顿 | 每帧都对全部历史回复逐行裁剪、重拼全部折叠组；每个 token 还会让组内工具重跑自带渲染器 | 回复与静态组按内容缓存；组失效不再级联到组内工具；中断的工具不再无限转圈 |

`npm run bench` 实测（120 列、每轮 1 条回复 + 3 个工具，每帧重绘整棵对话树）：

| 轮数 | 原版 0.1.3 | 本 fork | pi 原生 |
|---:|---:|---:|---:|
| 100 | 33 ms/帧 | 0.4 ms/帧 | 1.1 ms/帧 |
| 500 | 153 ms/帧 | 0.8 ms/帧 | 2.6 ms/帧 |
| 2000 | 549 ms/帧 | 4.1 ms/帧 | 9.4 ms/帧 |

原版上游没有声明许可证，本仓库保持私有，仅供个人使用。

## Preview

The collapsed view shows at most three lines by default:

```text
⠋ tool calling...
│  ✓ bash: npm test (3.2s)
└  · thinking: Checking the failing assertion… · ≈1.2K tok
```

Expand the group to inspect tool arguments, result previews, and more of the
reasoning content:

```text
✓ tool calling
│
├─ ✓ read: src/auth.ts (0.1s)
│  └─ export async function authenticate() { … }
│
├─ ✓ edit: src/auth.ts (0.2s)
│  └─ Updated src/auth.ts
│
└─ · thinking · 1.2K tok
   └─ The validation path now handles expired sessions…
```

## Features

- Combines consecutive **reasoning and tool calls** into a single visual group.
- Removes Pi's native hidden-thinking placeholder components so an empty
  thinking label cannot leave phantom blank rows in the transcript.
- Supports streaming reasoning, streaming tool output, and parallel tool calls.
- Displays tool state, argument summaries, elapsed time, and result previews.
- Shows reasoning-token usage. During streaming it uses an estimate, then
  prefers provider-reported usage when available.
- Follows Pi's standard `Ctrl+O` expand and collapse behavior.
- Renders fenced code blocks as subtle theme-aware background panels with
  syntax highlighting and one character of horizontal padding instead of
  decorative top and bottom border rows.
- Preserves Pi's native tool definitions and execution semantics.
- Keeps tools with rich renderers (plan, subagent, goal confirmation) outside
  the groups via a configurable `nativeTools` list.
- Gives compaction summaries a distinct, compact presentation.

## Installation

```bash
pi install git:github.com/Aaalice233/pi-compact-ui
```

Reload Pi:

```text
/reload
```

You can also load a local checkout temporarily:

```bash
pi -e ./compact-ui/index.ts
```

## Configuration

Open the interactive settings menu:

```text
/compact-ui-config
```

Available settings:

| Setting | Default | Purpose |
|---|---:|---|
| `collapsedMaxLines` | `3` | Maximum lines shown while a group is collapsed |
| `expandedToolLines` | `5` | Result-preview lines shown for each expanded tool |
| `expandedThinkingLines` | `10` | Reasoning-preview lines shown while expanded |
| `nativeTools` | see below | Tools that keep their own renderer and are never grouped; `*` wildcards allowed |

The configuration is stored at:

```text
~/.pi/agent/compact-ui.json
```

Example:

```json
{
  "collapsedMaxLines": 3,
  "expandedToolLines": 5,
  "expandedThinkingLines": 10,
  "nativeTools": [
    "plan_mode_complete",
    "subagent",
    "propose_goal_draft",
    "create_goal",
    "set_goal_tasks",
    "update_goal"
  ]
}
```

The file is created with defaults on first interactive start. Edits apply as
soon as the file is saved — no `/reload` needed. Changes affect tool calls
created afterwards; existing groups are not rebuilt. When `nativeTools` is
present it replaces the default list entirely.

## 历史思考恢复

恢复或切换会话、重建当前分支、压缩后显示保留消息以及 `/reload` 时，会从每条仍保留的助手消息恢复思考块。正文前后的思考按原顺序显示；纯思考消息和工具调用前的思考也有折叠入口。`Ctrl+O` 展开，预览行数仍由 `expandedThinkingLines` 控制，**并非无限制显示全文**。

- 只改变显示，不改写会话记录或发给模型的内容；实时消息结束时不会再重复生成历史组。
- 主题变化、宽度调整、重复重建后保留思考和展开状态；已完成的历史组使用缓存，不启动转圈。
- 无法恢复供应商未返回的思考、加密思考，或已从当前会话分支/压缩投影中移除的原文。
- plan-mode、subagent 和 goal-x 的 `nativeTools` 名单继续生效。

验证：`npm test` 使用真实 Pi 组件检查历史/流式渲染、顺序、去重、窄屏与独立模块重载；`npm run check` 检查类型。`npm run bench -- --thinking` 覆盖带历史思考的长会话缓存路径。自动测试不代替真实终端中的人工观感验收。

## Controls

| Action | Key |
|---|---|
| Expand or collapse reasoning and tool groups | `Ctrl+O` |
| Move through the settings menu | `Up` / `Down` |
| Adjust a numeric value | `Left` / `Right`, `-` / `+` |
| Save a setting | `Enter` |
| Close the settings menu | `Esc` |

## How It Works

compact-ui combines Pi's Assistant Message, Thinking, and Tool Execution
components at the presentation layer. It does not change the original messages
sent to the model or alter tool results.

Its main responsibilities are:

1. Capture reasoning blocks from the active assistant message.
2. Track consecutive and parallel tool calls.
3. Combine them into a tree component with shared state.
4. Seal the active group when visible assistant text begins, preserving clear
   message boundaries.

> [!NOTE]
> compact-ui does not re-register any tool. Built-in tool definitions, prompt
> guidelines, and settings such as `shellPath` stay untouched; the group simply
> does not render the tool components it owns. Terminal patches are installed
> only in interactive (TUI) sessions and removed on `session_shutdown` (kept
> across `/reload`, because Pi rebuilds the transcript before the new session starts).
