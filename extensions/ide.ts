/**
 * pi-ide: Claude Code-style IDE integration for pi.
 *
 * Connects to the WebSocket MCP server that the Claude Code IDE plugin
 * (VS Code / Cursor / JetBrains) already runs, then:
 *  - shows the current selection at the start of the input box,
 *  - attaches the selection to the next prompt (same wording as Claude Code),
 *  - pastes `@file#Lx-y` into the editor on the IDE's "insert at-mention" shortcut,
 *  - `/ide` to pick / switch / disconnect.
 *
 * Auto-connects only inside an IDE terminal (the plugin injects CLAUDE_CODE_SSE_PORT),
 * like Claude Code. Elsewhere use `/ide`.
 *
 * The IDE server keeps one client per window: connecting kicks out a running
 * `claude` session in the same window (and vice versa). So we never auto-reconnect.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";

export interface IdeLock {
	port: number;
	pid?: number;
	workspaceFolders: string[];
	ideName: string;
	authToken?: string;
}

export interface Selection {
	text?: string;
	filePath: string;
	selection?: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty?: boolean };
}

const MAX_LINES = 2000;
const CUSTOM_TYPE = "ide-selection";

export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "ide");
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid) return true; // unknown pid: let the connection attempt decide
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function contains(folder: string, path: string): boolean {
	const rel = relative(folder, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** All lock files whose IDE process is still alive; windows whose workspace contains `cwd` first. */
export function listLocks(dir = lockDir(), cwd?: string): IdeLock[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".lock"));
	} catch {
		return [];
	}
	const locks: IdeLock[] = [];
	for (const f of files) {
		try {
			const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
			if (raw.transport && raw.transport !== "ws") continue;
			const lock: IdeLock = { ...raw, port: Number(f.slice(0, -5)), workspaceFolders: raw.workspaceFolders ?? [] };
			if (pidAlive(lock.pid)) locks.push(lock);
		} catch {
			// half-written or foreign file
		}
	}
	if (cwd) {
		const hit = (l: IdeLock) => (l.workspaceFolders.some((w) => contains(w, cwd)) ? 0 : 1);
		locks.sort((a, b) => hit(a) - hit(b));
	}
	return locks;
}

/** The IDE whose integrated terminal we're running in (CLAUDE_CODE_SSE_PORT), if any. */
export function findLock(locks: IdeLock[], envPort: string | undefined): IdeLock | undefined {
	return envPort ? locks.find((l) => l.port === Number(envPort)) : undefined;
}

function displayPath(file: string, cwd: string): string {
	return contains(cwd, file) ? relative(cwd, file) : file;
}

/** 1-based inclusive line range, or undefined for an empty selection. */
function lineRange(sel: Selection): [number, number] | undefined {
	const s = sel.selection;
	if (!s || s.isEmpty || !sel.text) return undefined;
	let end = s.end.line;
	// Full-line selections end at column 0 of the next line.
	if (s.end.character === 0 && end > s.start.line) end--;
	return [s.start.line + 1, end + 1];
}

/** Model-facing text (same wording as Claude Code), a TUI summary, and the input-box chip. */
export function formatSelection(sel: Selection, cwd: string): { key: string; content: string; summary: string; chip: string } {
	const file = displayPath(sel.filePath, cwd);
	const range = lineRange(sel);
	if (!range || !sel.text) {
		return {
			key: sel.filePath,
			content: `The user opened the file ${file} in the IDE. This may or may not be related to the current task.`,
			summary: `Opened ${file}`,
			chip: `⧉ In ${basename(sel.filePath)}`,
		};
	}
	const [a, b] = range;
	const all = sel.text.split("\n");
	const text = all.length > MAX_LINES ? `${all.slice(0, MAX_LINES).join("\n")}\n... (truncated, ${all.length - MAX_LINES} more lines)` : sel.text;
	const n = b - a + 1;
	return {
		key: `${sel.filePath}:${a}-${b}:${sel.text.length}`,
		content: `The user selected the lines ${a} to ${b} from ${file}:\n${text}\n\nThis may or may not be related to the current task.`,
		summary: `Selected lines ${a}-${b} from ${file}`,
		chip: `⧉ ${n} line${n === 1 ? "" : "s"} selected`,
	};
}

/** Text pasted into the editor for an IDE at-mention (IDE sends 0-based lines). */
export function mentionText(m: { filePath: string; lineStart?: number; lineEnd?: number }, cwd: string): string {
	const file = displayPath(m.filePath, cwd);
	if (m.lineStart === undefined) return `@${file} `;
	const a = m.lineStart + 1;
	const b = (m.lineEnd ?? m.lineStart) + 1;
	return a === b ? `@${file}#L${a} ` : `@${file}#L${a}-${b} `;
}

/** Default pi editor + the IDE chip at the start of its top border (yields to working status / scroll hint). */
export class IdeEditor extends CustomEditor {
	getChip: () => string | undefined;
	busy = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, getChip: () => string | undefined) {
		// ponytail: default paddingX/autocompleteMaxVisible; ignores editorPaddingX/autocompleteMaxVisible settings.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.getChip = getChip;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		this.busy = indicator !== undefined;
		super.setWorkingStatusIndicator(indicator);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const chip = this.getChip();
		if (!chip || this.busy || hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
		const label = ` ${chip} `;
		const rest = width - 2 - visibleWidth(label);
		if (rest < 1) return super.renderTopBorder(width, hiddenLineCount);
		return this.borderColor("──") + label + this.borderColor("─".repeat(rest));
	}
}

export default function (pi: ExtensionAPI) {
	let ws: WebSocket | undefined;
	let lock: IdeLock | undefined;
	let latest: Selection | undefined;
	let lastInjected: string | undefined;
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let inEditor = false;

	const chipText = (): string | undefined => {
		if (!ws || !lock || !ctx) return undefined;
		return latest ? formatSelection(latest, ctx.cwd).chip : `⧉ ${lock.ideName}`;
	};

	const refresh = () => {
		if (!ctx) return;
		if (inEditor) tui?.requestRender();
		else ctx.ui.setStatus("ide", chipText());
	};

	const disconnect = () => {
		const old = ws;
		ws = undefined;
		lock = undefined;
		latest = undefined;
		old?.close();
		refresh();
	};

	const connect = (target: IdeLock) => {
		disconnect();
		// JetBrains plugin rejects the upgrade without the "mcp" subprotocol; VS Code/Cursor accept it.
		const sock = new WebSocket(`ws://127.0.0.1:${target.port}`, {
			protocols: ["mcp"],
			headers: target.authToken ? { "x-claude-code-ide-authorization": target.authToken } : {},
		});
		ws = sock;
		lock = target;
		let opened = false;
		const send = (msg: { id?: number; method: string; params?: Record<string, unknown> }) =>
			sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ jsonrpc: "2.0", ...msg }));

		sock.onopen = () => {
			opened = true;
			send({
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "0.1.0" } },
			});
		};
		sock.onmessage = (ev) => {
			if (ws !== sock) return;
			let msg: any;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.id === 1 && msg.result) {
				send({ method: "notifications/initialized" });
				send({ method: "ide_connected", params: { pid: process.pid } });
				// selection_changed only fires on cursor moves; seed with the current one (VS Code/Cursor only).
				send({ id: 2, method: "tools/call", params: { name: "getLatestSelection", arguments: {} } });
				refresh();
			} else if (msg.id === 2 && !latest) {
				try {
					const sel = JSON.parse(msg.result?.content?.[0]?.text ?? "{}");
					if (sel.filePath) latest = sel;
				} catch {
					// malformed seed: wait for the next selection_changed
				}
				refresh();
			} else if (msg.method === "selection_changed" && msg.params?.filePath) {
				latest = msg.params;
				refresh();
			} else if (msg.method === "at_mentioned" && msg.params?.filePath && ctx) {
				ctx.ui.pasteToEditor(mentionText(msg.params, ctx.cwd));
			}
		};
		sock.onerror = () => {};
		sock.onclose = (ev) => {
			if (ws !== sock) return; // replaced or disconnected on purpose
			disconnect();
			const why = ev.reason ? `: ${ev.reason}` : "";
			ctx?.ui.notify(
				opened ? `IDE disconnected (${target.ideName}${why}). Run /ide to reconnect.` : `Failed to connect to ${target.ideName}${why}.`,
				"warning",
			);
		};
	};

	pi.on("session_start", (_e, c) => {
		ctx = c;
		lastInjected = undefined;
		if (!c.hasUI) return;
		inEditor = c.mode === "tui" && !c.ui.getEditorComponent();
		if (inEditor) {
			c.ui.setEditorComponent((t, theme, kb) => {
				tui = t;
				return new IdeEditor(t, theme, kb, chipText);
			});
		}
		const hit = findLock(listLocks(), process.env.CLAUDE_CODE_SSE_PORT);
		if (hit) connect(hit);
	});

	pi.on("session_shutdown", () => {
		disconnect();
		ctx = undefined;
		tui = undefined;
	});

	pi.on("before_agent_start", (_e, c) => {
		if (!ws || !latest) return;
		const f = formatSelection(latest, c.cwd);
		if (f.key === lastInjected) return;
		lastInjected = f.key;
		return { message: { customType: CUSTOM_TYPE, content: f.content, display: true, details: { summary: f.summary } } };
	});

	pi.registerMessageRenderer<{ summary?: string }>(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		let text = theme.fg("dim", `⧉ ${message.details?.summary ?? "IDE context"}`);
		if (expanded && typeof message.content === "string") text += `\n${theme.fg("muted", message.content)}`;
		return new Text(text, outputPad, 0);
	});

	pi.registerCommand("ide", {
		description: "Connect to an IDE running the Claude Code plugin (VS Code / Cursor / JetBrains)",
		handler: async (_args, c) => {
			ctx = c;
			const locks = listLocks(lockDir(), c.cwd);
			if (!locks.length) {
				c.ui.notify("No IDE found. Install the Claude Code extension/plugin in your IDE and open a project.", "warning");
				return;
			}
			const label = (l: IdeLock) =>
				`${l.ideName} · ${l.workspaceFolders.join(", ") || "(no folder)"}${lock?.port === l.port ? "  ✓ connected" : ""}`;
			const options = locks.map(label);
			if (lock) options.push("Disconnect");
			const pick = await c.ui.select("Select IDE", options);
			if (!pick) return;
			if (pick === "Disconnect") {
				disconnect();
				c.ui.notify("IDE disconnected", "info");
				return;
			}
			const target = locks[options.indexOf(pick)];
			if (target) connect(target);
		},
	});
}
