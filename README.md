# pi-ide

Claude Code 式的 IDE 集成，给 [pi](https://github.com/earendil-works/pi) 用。直接复用 Claude Code 的 IDE 插件，不用再装别的 IDE 扩展。

- 输入框上边框最左侧实时显示选区：`⧉ 12 lines selected` / `⧉ In foo.ts` / `⧉ IntelliJ IDEA`。agent 运行时这里显示 pi 自己的运行状态。
- 发消息时自动附带选区，文案和 Claude Code 一致。发过一次，或按 Esc 跳过后，提示变回 `⧉ IDE 名称`；在 IDE 里再动一下光标或选区（包括重新点当前文件）就恢复，并在下条消息里附带。
- 改完文件后，把 IDE 里新出现的报错附给模型，并提供 `ide_diagnostics` 工具。
- 在 IDE 里按 `cmd+alt+K`（Claude Code 的 "Insert At-Mention"），pi 输入框里会插入 `@path#L5-10`。
- `/ide`：列出 IDE 窗口，可以切换或断开；也能切换“没选中时是否附带当前打开的文件”，设置保存在 `~/.pi/agent/pi-ide.json`。

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

和 Claude Code 一样，只在 IDE 的集成终端里自动连接：

- 终端里有 `CLAUDE_CODE_SSE_PORT`（插件注入）时，连这个端口。
- 否则，如果 IDE 进程是 pi 的祖先进程，并且它的 workspace 包含当前目录，就连这个窗口。这样刚打开的工作区、端口变了的窗口也能连上。
- lock 文件可能比终端晚一点出现，启动后最多等 30 秒。
- 其他终端（iTerm 等）不自动连接，用 `/ide` 手动选，workspace 包含当前目录的窗口排在前面。

## 诊断

- VS Code / Cursor：和 Claude Code 一样，改文件前记录这个文件当前的诊断，改完后把新出现的问题用 `<new-diagnostics>` 附在这次工具调用的结果后面。按文件的修改时间判断是否改过，所以 `edit`、`write`、只带锚点的编辑工具、`bash` 改的文件都能覆盖。
- 连上 IDE 后才启用 `ide_diagnostics` 工具，模型可以主动查单个文件或全部文件。
- JetBrains 插件按文件查诊断经常超时，Claude Code 对 JetBrains 也关掉了自动诊断，这里一样只提供工具。

## 注意

- VS Code / Cursor 一个窗口只接受一个客户端：pi 连上会踢掉这个窗口里的 `claude`，反过来也一样。这种情况不会自动重连，免得两边来回互踢，要重连就运行 `/ide`。
- JetBrains 可以和 `claude` 同时连着；断线后会自动重连到同一个项目，IDE 重启后端口变了也能连上。两边都连着时，在 IDE 里按 `cmd+alt+K`，pi 和 `claude` 都会收到引用。
- JetBrains 插件不提供选区查询接口，刚连上时只显示 `⧉ IntelliJ IDEA`，在编辑器里动一下光标后才会出现选区。
- 如果别的扩展已经替换了 pi 的输入框，选区提示会改到底部状态栏显示，此时不支持按 Esc 跳过。

## 开发

```bash
npm install
npm run typecheck
npm test
```

发布：`npm version patch && git push --follow-tags`。推送 `v*` tag 后，GitHub Actions 会跑类型检查和测试，并用 npm trusted publishing 发布，不需要 token。
