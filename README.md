# pi-ide

Claude Code 式的 IDE 集成，给 [pi](https://github.com/earendil-works/pi) 用。直接复用 Claude Code 的 IDE 插件，不用再装别的 IDE 扩展。

- 输入框上边框最左侧实时显示选区：`⧉ 12 lines selected` / `⧉ In foo.ts` / `⧉ IntelliJ IDEA`（agent 运行时让位给工作状态）
- 发消息时自动附带选区，文案和 Claude Code 一致；选区没变不会重复附带
- 在 IDE 里按 `cmd+alt+K`（Claude Code 的 "Insert At-Mention"），pi 输入框里会插入 `@path#L5-10`
- `/ide`：列出 IDE 窗口、切换或断开连接

## 前提

IDE 里装好 Claude Code 插件并打开项目：

- VS Code / Cursor：`anthropic.claude-code`
- JetBrains：`Claude Code [Beta]`

插件会在 `~/.claude/ide/<port>.lock` 写入连接信息。

## 安装

```bash
pi install npm:pi-ide
```

## 连接规则

和 Claude Code 一样：

- 在 IDE 的集成终端里启动 pi：自动连接这个 IDE 窗口（插件会在终端里注入 `CLAUDE_CODE_SSE_PORT`）。插件装好前就已打开的终端没有这个变量，要新开一个终端。
- 其他终端（iTerm 等）：不自动连接，用 `/ide` 手动选择；workspace 包含当前目录的窗口排在前面。

## 注意

- 一个 IDE 窗口同一时间只接受一个客户端。pi 连上后会踢掉这个窗口里正在跑的 `claude`，反过来也一样。断线后 pi 不会自动重连，免得两边来回互踢，需要重连时运行 `/ide`。
- JetBrains 插件不提供选区查询接口，刚连上时只显示 `⧉ IntelliJ IDEA`，在编辑器里动一下光标后才会出现选区。
- 如果别的扩展已经替换了 pi 的输入框，指示会退回底部状态栏显示。

## 开发

```bash
npm install
npm run typecheck
npm test
```
