/**
 * pi-ide: Claude Code-style IDE integration for pi.
 *
 * Connects to the WebSocket MCP server that the Claude Code IDE plugin
 * (VS Code / Cursor / JetBrains) already runs, then:
 *  - shows the current selection at the start of the input box (Esc to skip it once),
 *  - attaches the selection to the next prompt (same wording as Claude Code),
 *  - appends new IDE diagnostics to the result of any tool that changed a file (VS Code family),
 *  - `ide_diagnostics` tool, `@file#Lx-y` on the IDE's at-mention shortcut, `/ide` menu.
 *
 * Auto-connect follows Claude Code: inside an IDE terminal (CLAUDE_CODE_SSE_PORT, or the IDE
 * process is our ancestor and its workspace contains cwd), polling up to 30s for the lock file.
 *
 * VS Code/Cursor keep one client per window (a new client kicks the old one), so we don't
 * reconnect there. JetBrains allows several clients, so we reconnect automatically.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------- locks & auto-connect

export interface IdeLock {
	port: number;
	pid?: number;
	workspaceFolders: string[];
	ideName: string;
	authToken?: string;
}

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

/**
 * The IDE whose terminal we're in, like Claude Code: the CLAUDE_CODE_SSE_PORT window, else the
 * single window whose IDE process is our ancestor and whose workspace contains cwd.
 */
export function pickLock(locks: IdeLock[], envPort: string | undefined, cwd: string, ancestors: Set<number>): IdeLock | undefined {
	if (envPort) {
		const hit = locks.find((l) => l.port === Number(envPort));
		if (hit) return hit;
	}
	const hits = locks.filter((l) => l.pid !== undefined && ancestors.has(l.pid) && l.workspaceFolders.some((w) => contains(w, cwd)));
	return hits.length === 1 ? hits[0] : undefined;
}

/** Up to `depth` ancestor pids of `pid` (empty where `ps` is unavailable, e.g. Windows). */
export function ancestorPids(pid = process.ppid, depth = 10): Set<number> {
	const out = new Set<number>();
	let table: string;
	try {
		table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
	} catch {
		return out;
	}
	const parent = new Map<number, number>();
	for (const line of table.split("\n")) {
		const [p, pp] = line.trim().split(/\s+/).map(Number);
		if (p && pp !== undefined) parent.set(p, pp);
	}
	for (let cur: number | undefined = pid; cur && cur > 1 && out.size < depth; cur = parent.get(cur)) out.add(cur);
	return out;
}

// ---------------------------------------------------------------- selection

export interface Selection {
	text?: string;
	filePath: string;
	selection?: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty?: boolean };
}

const MAX_LINES = 2000;
const CUSTOM_TYPE = "ide-selection";

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
export function formatSelection(
	sel: Selection,
	cwd: string,
): { content: string; summary: string; chip: string; hasText: boolean } {
	const file = displayPath(sel.filePath, cwd);
	const range = lineRange(sel);
	if (!range || !sel.text) {
		return {
			content: `The user opened the file ${file} in the IDE. This may or may not be related to the current task.`,
			summary: `Opened ${file}`,
			chip: `⧉ In ${basename(sel.filePath)}`,
			hasText: false,
		};
	}
	const [a, b] = range;
	const all = sel.text.split("\n");
	const text = all.length > MAX_LINES ? `${all.slice(0, MAX_LINES).join("\n")}\n... (truncated, ${all.length - MAX_LINES} more lines)` : sel.text;
	const n = b - a + 1;
	return {
		content: `The user selected the lines ${a} to ${b} from ${file}:\n${text}\n\nThis may or may not be related to the current task.`,
		summary: `Selected lines ${a}-${b} from ${file}`,
		chip: `⧉ ${n} line${n === 1 ? "" : "s"} selected`,
		hasText: true,
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

// ---------------------------------------------------------------- diagnostics

export interface Diagnostic {
	message: string;
	severity?: unknown;
	source?: string;
	code?: unknown;
	range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
}
export interface FileDiagnostics {
	uri: string;
	diagnostics: Diagnostic[];
}

const MAX_DIAG_CHARS = 4000;
const ICON: Record<string, string> = { Error: "✗", Warning: "⚠", Info: "ℹ", Hint: "★" };

const diagKey = (d: Diagnostic) =>
	JSON.stringify([d.message, d.severity, d.source, d.code, d.range?.start?.line, d.range?.start?.character, d.range?.end?.line, d.range?.end?.character]);

/** Diagnostics in `now` that weren't in `before`. */
export function newDiagnostics(before: Diagnostic[], now: Diagnostic[]): Diagnostic[] {
	const seen = new Set(before.map(diagKey));
	return now.filter((d) => !seen.has(diagKey(d)));
}

export function uriToPath(uri: string): string {
	try {
		return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
	} catch {
		return uri;
	}
}

/** Claude Code's diagnostics listing: `file:\n  ✗ [Line 3:5] message [code] (source)`. */
export function formatDiagnostics(files: FileDiagnostics[], cwd: string, max = MAX_DIAG_CHARS): string {
	const text = files
		.filter((f) => f.diagnostics.length)
		.map((f) => {
			const lines = f.diagnostics.map((d) => {
				const s = d.range?.start;
				const at = s ? ` [Line ${(s.line ?? 0) + 1}:${(s.character ?? 0) + 1}]` : "";
				const icon = (typeof d.severity === "string" && ICON[d.severity]) || "•";
				return `  ${icon}${at} ${d.message}${d.code ? ` [${d.code}]` : ""}${d.source ? ` (${d.source})` : ""}`;
			});
			return `${displayPath(uriToPath(f.uri), cwd)}:\n${lines.join("\n")}`;
		})
		.join("\n\n");
	return text.length > max ? `${text.slice(0, max - 12)}…[truncated]` : text;
}

/** The IDE tool's JSON payload, or [] (JetBrains returns plain text like "Timeout getting diagnostics"). */
export function parseDiagnostics(result: unknown): FileDiagnostics[] {
	try {
		const v = JSON.parse(resultText(result) ?? "");
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

function resultText(result: unknown): string | undefined {
	const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
	return content?.find((c) => c.type === "text")?.text;
}

// ---------------------------------------------------------------- settings

interface Settings {
	/** Attach the open file when nothing is selected (Claude Code's claudeCode.attachOpenFile). */
	attachOpenFile: boolean;
}

const settingsPath = () => join(getAgentDir(), "pi-ide.json");

function loadSettings(): Settings {
	try {
		return { attachOpenFile: true, ...JSON.parse(readFileSync(settingsPath(), "utf8")) };
	} catch {
		return { attachOpenFile: true };
	}
}

// ---------------------------------------------------------------- editor chip

export interface Chip {
	text: string;
	/** Won't be attached (nothing to attach, or open-file attaching is off). */
	dim: boolean;
}

/** Default pi editor + the IDE chip at the start of its top border. Esc skips the chip once. */
export class IdeEditor extends CustomEditor {
	getChip: () => Chip | undefined;
	onDismiss: () => void;
	kb: KeybindingsManager;
	busy = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, getChip: () => Chip | undefined, onDismiss: () => void) {
		// ponytail: default paddingX/autocompleteMaxVisible; ignores editorPaddingX/autocompleteMaxVisible settings.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.kb = keybindings;
		this.getChip = getChip;
		this.onDismiss = onDismiss;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		this.busy = indicator !== undefined;
		super.setWorkingStatusIndicator(indicator);
	}

	override handleInput(data: string): void {
		const chip = this.getChip();
		if (chip && !chip.dim && !this.busy && !this.isShowingAutocomplete() && this.kb.matches(data, "app.interrupt")) {
			this.onDismiss();
			return;
		}
		super.handleInput(data);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const chip = this.getChip();
		if (!chip || this.busy || hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
		const label = ` ${chip.text} `;
		const rest = width - 2 - visibleWidth(label);
		if (rest < 1) return super.renderTopBorder(width, hiddenLineCount);
		return this.borderColor("──") + (chip.dim ? this.borderColor(label) : label) + this.borderColor("─".repeat(rest));
	}
}

// ---------------------------------------------------------------- extension

const TOOL = "ide_diagnostics";
const JETBRAINS = "Claude Code JetBrains Plugin";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Baseline = { mtime: number; diagnostics: Diagnostic[] };

export default function (pi: ExtensionAPI) {
	let ws: WebSocket | undefined;
	let lock: IdeLock | undefined;
	let serverName = "";
	let nextId = 1;
	const pending = new Map<number, Pending>();
	let latest: Selection | undefined;
	// The exact selection event that was sent or skipped with Esc; any new selection_changed shows the chip again.
	let handled: Selection | undefined;
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let inEditor = false;
	let settings = loadSettings();
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnecting: string | undefined; // workspace key we're silently trying to get back to
	const baselines = new Map<string, Baseline>();
	let baselineTimeouts = 0;
	let diagQueue: Promise<unknown> = Promise.resolve();

	const multiClient = () => serverName === JETBRAINS;
	const wsKey = (l: IdeLock) => l.workspaceFolders.join("\n");

	// ---- JSON-RPC over the IDE socket

	const send = (msg: Record<string, unknown>) => {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", ...msg }));
	};

	const rpc = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
		new Promise<unknown>((res, rej) => {
			if (ws?.readyState !== WebSocket.OPEN) return rej(new Error("IDE not connected"));
			const id = nextId++;
			const timer = setTimeout(() => {
				pending.delete(id);
				rej(new Error(`IDE ${method} timed out`));
			}, timeoutMs);
			pending.set(id, { resolve: res, reject: rej, timer });
			send({ id, method, params });
		});

	const callTool = (name: string, args: Record<string, unknown>, timeoutMs: number) =>
		rpc("tools/call", { name, arguments: args }, timeoutMs);

	// ---- UI state

	const selInfo = () => (latest && ctx ? formatSelection(latest, ctx.cwd) : undefined);

	/** What would be attached to the next prompt, if anything (not already sent or skipped). */
	const attachable = () => {
		const f = selInfo();
		if (!ws || !f || latest === handled || (!f.hasText && !settings.attachOpenFile)) return undefined;
		return f;
	};

	const chip = (): Chip | undefined => {
		if (!ws || !lock) return undefined;
		// Show the selection only when it will be attached; otherwise (none, sent, skipped) just the IDE name.
		const f = attachable();
		return f ? { text: f.chip, dim: false } : { text: `⧉ ${lock.ideName}`, dim: true };
	};

	const refresh = () => {
		if (!ctx) return;
		if (inEditor) tui?.requestRender();
		else {
			const c = chip();
			ctx.ui.setStatus("ide", c && (c.dim ? ctx.ui.theme.fg("dim", c.text) : c.text));
		}
	};

	const setToolActive = (on: boolean) => {
		const active = pi.getActiveTools();
		if (active.includes(TOOL) === on) return;
		pi.setActiveTools(on ? [...active, TOOL] : active.filter((t) => t !== TOOL));
	};

	// ---- connection

	const stopPoll = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	};

	const disconnect = () => {
		const old = ws;
		ws = undefined;
		lock = undefined;
		serverName = "";
		latest = undefined;
		baselines.clear();
		baselineTimeouts = 0;
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("IDE disconnected"));
		}
		pending.clear();
		old?.close();
		if (ctx) setToolActive(false);
		refresh();
	};

	/** Re-check `find` every `every` ms until it returns a lock (connect) or `until` passes. */
	const poll = (find: () => IdeLock | undefined, every: number, until: number, delay = 0) => {
		stopPoll();
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			if (ws) return;
			const hit = find();
			if (hit) connect(hit);
			else if (Date.now() + every < until) poll(find, every, until, every);
		}, delay);
	};

	const reconnect = (key: string) => {
		reconnecting = key;
		poll(() => listLocks().find((l) => wsKey(l) === key), 2000, Number.POSITIVE_INFINITY, 2000);
	};

	const connect = (target: IdeLock) => {
		stopPoll();
		disconnect();
		// JetBrains rejects the upgrade without the "mcp" subprotocol; VS Code/Cursor accept it.
		const sock = new WebSocket(`ws://127.0.0.1:${target.port}`, {
			protocols: ["mcp"],
			headers: target.authToken ? { "x-claude-code-ide-authorization": target.authToken } : {},
		});
		ws = sock;
		lock = target;
		let opened = false;

		sock.onopen = async () => {
			opened = true;
			try {
				const init = (await rpc(
					"initialize",
					{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "0.2.0" } },
					5000,
				)) as { serverInfo?: { name?: string } };
				if (ws !== sock) return;
				serverName = init?.serverInfo?.name ?? "";
				send({ method: "notifications/initialized" });
				send({ method: "ide_connected", params: { pid: process.pid } });
			} catch {
				sock.close();
				return;
			}
			reconnecting = undefined;
			setToolActive(true);
			refresh();
			// selection_changed only fires on cursor moves; seed with the current one (JetBrains has no such tool).
			if (!multiClient()) {
				try {
					const sel = JSON.parse(resultText(await callTool("getLatestSelection", {}, 3000)) ?? "{}");
					if (ws === sock && !latest && sel.filePath) latest = sel;
				} catch {
					// no seed: wait for the next selection_changed
				}
				refresh();
			}
		};
		sock.onmessage = (ev) => {
			if (ws !== sock) return;
			let msg: any;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.id !== undefined && !msg.method) {
				const p = pending.get(msg.id);
				if (!p) return;
				pending.delete(msg.id);
				clearTimeout(p.timer);
				if (msg.error) p.reject(new Error(msg.error.message ?? "IDE error"));
				else p.resolve(msg.result);
			} else if (msg.id !== undefined) {
				send({ id: msg.id, result: {} }); // server requests, e.g. JetBrains ping
			} else if (msg.method === "selection_changed" && msg.params?.filePath) {
				// Keep the same object on duplicate events so they don't bring back a sent/skipped selection.
				if (JSON.stringify(msg.params) !== JSON.stringify(latest)) latest = msg.params;
				refresh();
			} else if (msg.method === "at_mentioned" && msg.params?.filePath && ctx) {
				ctx.ui.pasteToEditor(mentionText(msg.params, ctx.cwd));
			}
		};
		sock.onerror = () => {};
		sock.onclose = (ev) => {
			if (ws !== sock) return; // replaced or disconnected on purpose
			const wasMulti = multiClient();
			const quiet = reconnecting === wsKey(target);
			disconnect();
			if (quiet || (opened && wasMulti)) {
				if (!quiet) ctx?.ui.notify(`${target.ideName} disconnected, reconnecting…`, "info");
				reconnect(wsKey(target));
				return;
			}
			const why = ev.reason ? `: ${ev.reason}` : "";
			ctx?.ui.notify(
				opened ? `IDE disconnected (${target.ideName}${why}). Run /ide to reconnect.` : `Failed to connect to ${target.ideName}${why}.`,
				"warning",
			);
		};
	};

	// ---- diagnostics (Claude Code: baseline before an edit, report what's new after it)

	const mtimeOf = (path: string) => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return -1;
		}
	};

	const baseline = async (path: string) => {
		const mtime = mtimeOf(path);
		if (baselines.get(path)?.mtime === mtime) return;
		try {
			const files = parseDiagnostics(await callTool("getDiagnostics", { uri: pathToFileURL(path).href }, 500));
			baselineTimeouts = 0;
			baselines.delete(path); // re-insert as newest
			baselines.set(path, { mtime, diagnostics: files.find((f) => uriToPath(f.uri) === path)?.diagnostics ?? [] });
			if (baselines.size > 50) baselines.delete(baselines.keys().next().value!);
		} catch {
			baselineTimeouts++; // ponytail: like Claude Code, give up on baselines after 3 timeouts in a row
		}
	};

	/** New diagnostics text for tracked files whose mtime changed, or undefined. */
	const checkDiagnostics = async (): Promise<string | undefined> => {
		const changed = [...baselines].filter(([p, b]) => mtimeOf(p) !== b.mtime).map(([p]) => p);
		if (!changed.length || !ctx) return undefined;
		await new Promise((r) => setTimeout(r, 1500)); // let the language server catch up
		let files: FileDiagnostics[];
		try {
			files = parseDiagnostics(await callTool("getDiagnostics", {}, 2000));
		} catch {
			return undefined;
		}
		const found: FileDiagnostics[] = [];
		for (const path of changed) {
			const before = baselines.get(path);
			if (!before) continue;
			const now = files.find((f) => uriToPath(f.uri) === path)?.diagnostics ?? [];
			const fresh = newDiagnostics(before.diagnostics, now);
			if (fresh.length) found.push({ uri: pathToFileURL(path).href, diagnostics: fresh });
			baselines.set(path, { mtime: mtimeOf(path), diagnostics: now });
		}
		if (!found.length || !ctx) return undefined;
		return `<new-diagnostics>The following new diagnostic issues were detected:\n\n${formatDiagnostics(found, ctx.cwd)}</new-diagnostics>`;
	};

	const diagnosticsOn = () => ws && !multiClient() && baselineTimeouts < 3; // JetBrains per-file queries time out

	pi.on("tool_call", async (event, c) => {
		if (!diagnosticsOn()) return;
		const input = event.input as Record<string, unknown>;
		const raw = [input.path, input.file_path, input.filePath].find((v) => typeof v === "string") as string | undefined;
		if (!raw) return;
		const path = resolve(c.cwd, raw.replace(/^@/, ""));
		const kind = (() => {
			try {
				return statSync(path).isFile() ? "file" : "other";
			} catch {
				return "missing";
			}
		})();
		if (kind === "other") return;
		// Reads are baselined in the background so anchor-based edits (no path) still get a baseline.
		const job = baseline(path);
		if (event.toolName !== "read") await job;
	});

	pi.on("tool_result", async (event) => {
		if (!diagnosticsOn() || !baselines.size) return;
		const run = diagQueue.then(checkDiagnostics, () => undefined);
		diagQueue = run.catch(() => undefined);
		const text = await run.catch(() => undefined);
		if (text) return { content: [...event.content, { type: "text" as const, text }] };
	});

	pi.registerTool({
		name: TOOL,
		label: "IDE Diagnostics",
		description:
			"Get language diagnostics (type errors, lint warnings) from the connected IDE. Omit `uri` for every file the IDE has diagnostics for.",
		promptSnippet: "Get type errors and lint warnings from the connected IDE",
		promptGuidelines: [`Use ${TOOL} to check a file for IDE-reported errors after editing it or before claiming the code compiles.`],
		parameters: Type.Object({
			uri: Type.Optional(Type.String({ description: "File path or file:// URI. Omit for all files." })),
		}),
		async execute(_id, params, _signal, _onUpdate, c) {
			if (!ws) throw new Error("No IDE connected. Ask the user to run /ide.");
			const uri = params.uri && (params.uri.startsWith("file:") ? params.uri : pathToFileURL(resolve(c.cwd, params.uri)).href);
			const result = await callTool("getDiagnostics", uri ? { uri } : {}, 10000);
			const files = parseDiagnostics(result);
			const text = files.length ? formatDiagnostics(files, c.cwd, 20000) || "No diagnostics." : (resultText(result) ?? "No diagnostics.");
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ---- lifecycle

	pi.on("session_start", (_e, c) => {
		ctx = c;
		handled = undefined;
		settings = loadSettings();
		setToolActive(false);
		if (!c.hasUI) return;
		inEditor = c.mode === "tui" && !c.ui.getEditorComponent();
		if (inEditor) {
			c.ui.setEditorComponent((t, theme, kb) => {
				tui = t;
				return new IdeEditor(t, theme, kb, chip, () => {
					handled = latest;
					refresh();
				});
			});
		}
		const envPort = process.env.CLAUDE_CODE_SSE_PORT;
		const ancestors = ancestorPids();
		// Only inside an IDE terminal; the lock may appear a bit after the terminal opens.
		if (envPort || listLocks().some((l) => l.pid && ancestors.has(l.pid)) || process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm") {
			poll(() => pickLock(listLocks(), envPort, c.cwd, ancestors), 1000, Date.now() + 30_000);
		}
	});

	pi.on("session_shutdown", () => {
		stopPoll();
		reconnecting = undefined;
		ctx = undefined;
		disconnect();
		tui = undefined;
	});

	pi.on("before_agent_start", () => {
		const f = attachable();
		if (!f) return;
		handled = latest;
		refresh(); // chip falls back to the IDE name until the selection changes
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
			const label = (l: IdeLock) =>
				`${l.ideName} · ${l.workspaceFolders.join(", ") || "(no folder)"}${lock?.port === l.port ? "  ✓ connected" : ""}`;
			const options = locks.map(label);
			const toggle = `Attach open file when nothing is selected: ${settings.attachOpenFile ? "on" : "off"}`;
			options.push(toggle);
			if (lock) options.push("Disconnect");
			if (!locks.length) c.ui.notify("No IDE found. Install the Claude Code extension/plugin in your IDE and open a project.", "warning");
			const pick = await c.ui.select("IDE", options);
			if (!pick) return;
			if (pick === toggle) {
				settings = { ...settings, attachOpenFile: !settings.attachOpenFile };
				try {
					writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
				} catch (e) {
					c.ui.notify(`Could not save ${settingsPath()}: ${(e as Error).message}`, "warning");
				}
				refresh();
			} else if (pick === "Disconnect") {
				stopPoll();
				reconnecting = undefined;
				disconnect();
				c.ui.notify("IDE disconnected", "info");
			} else {
				const target = locks[options.indexOf(pick)];
				if (target) {
					reconnecting = undefined;
					connect(target);
				}
			}
		},
	});
}
