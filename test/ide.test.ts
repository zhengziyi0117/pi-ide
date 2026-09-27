import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ancestorPids,
	formatDiagnostics,
	formatSelection,
	type IdeLock,
	listLocks,
	mentionText,
	newDiagnostics,
	parseDiagnostics,
	pickLock,
	uriToPath,
} from "../extensions/ide.ts";

const lock = (port: number, ...workspaceFolders: string[]): IdeLock => ({ port, workspaceFolders, ideName: `ide${port}` });

test("listLocks: reads ws locks, drops dead pids, junk and non-ws", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-"));
	try {
		writeFileSync(join(dir, "1111.lock"), JSON.stringify({ pid: process.pid, workspaceFolders: ["/a"], ideName: "Cursor", transport: "ws", authToken: "t" }));
		writeFileSync(join(dir, "2222.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, workspaceFolders: ["/b"], ideName: "Dead", transport: "ws" }));
		writeFileSync(join(dir, "3333.lock"), "{not json");
		writeFileSync(join(dir, "4444.lock"), JSON.stringify({ pid: process.pid, workspaceFolders: ["/c"], ideName: "Old", transport: "sse" }));
		writeFileSync(join(dir, "notes.txt"), "x");
		const locks = listLocks(dir);
		assert.deepEqual(locks.map((l) => [l.port, l.ideName, l.authToken]), [[1111, "Cursor", "t"]]);
		assert.deepEqual(listLocks(join(dir, "missing")), []);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("pickLock: SSE_PORT, else the one ancestor IDE whose workspace contains cwd (like CC)", () => {
	const l = (port: number, pid: number, folder: string): IdeLock => ({ ...lock(port, folder), pid });
	const idea = 100;
	const locks = [l(1, idea, "/work/app"), l(2, idea, "/work/other"), l(3, 200, "/work/app")];
	assert.equal(pickLock(locks, "2", "/work/app", new Set())?.port, 2); // env wins
	assert.equal(pickLock(locks, undefined, "/work/app/src", new Set([idea]))?.port, 1); // new workspace: no env
	assert.equal(pickLock(locks, "999", "/work/app/src", new Set([idea]))?.port, 1); // stale env falls back
	assert.equal(pickLock(locks, undefined, "/work/app", new Set()), undefined); // plain terminal: use /ide
	assert.equal(pickLock(locks, undefined, "/work/app", new Set([idea, 200])), undefined); // ambiguous: don't guess
});

test("listLocks: windows containing cwd sort first (for /ide)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-"));
	try {
		const w = (port: number, folder: string) =>
			writeFileSync(join(dir, `${port}.lock`), JSON.stringify({ pid: process.pid, workspaceFolders: [folder], ideName: `ide${port}`, transport: "ws" }));
		w(1111, "/other");
		w(2222, "/work/app");
		w(3333, "/work/app-x");
		assert.equal(listLocks(dir, "/work/app/src")[0]?.port, 2222);
		assert.equal(listLocks(dir, "/work/app-xy").some((l) => l.port === 3333), true); // still listed, just not first
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("formatSelection: 1-based range, CC wording, relative path", () => {
	const f = formatSelection(
		{ filePath: "/p/src/a.ts", text: "x\ny\n", selection: { start: { line: 4, character: 0 }, end: { line: 6, character: 0 }, isEmpty: false } },
		"/p",
	);
	assert.equal(f.content, "The user selected the lines 5 to 6 from src/a.ts:\nx\ny\n\n\nThis may or may not be related to the current task.");
	assert.equal(f.summary, "Selected lines 5-6 from src/a.ts");
	assert.equal(f.chip, "⧉ 2 lines selected");

	const one = formatSelection({ filePath: "/p/a.ts", text: "foo", selection: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } } }, "/p");
	assert.equal(one.chip, "⧉ 1 line selected");
});

test("formatSelection: empty selection -> opened file; outside cwd keeps absolute path", () => {
	const f = formatSelection({ filePath: "/elsewhere/b.ts", text: "", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 }, isEmpty: true } }, "/p");
	assert.equal(f.content, "The user opened the file /elsewhere/b.ts in the IDE. This may or may not be related to the current task.");
	assert.equal(f.chip, "⧉ In b.ts");

	// JetBrains sends no isEmpty; empty text means just the open file.
	const jb = formatSelection({ filePath: "/p/c.kt", text: "", selection: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } } }, "/p");
	assert.equal(jb.chip, "⧉ In c.kt");
});

test("formatSelection: truncates huge selections", () => {
	const text = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
	const f = formatSelection({ filePath: "/p/a.ts", text, selection: { start: { line: 0, character: 0 }, end: { line: 2499, character: 5 } } }, "/p");
	assert.match(f.content, /truncated, 500 more lines/);
	assert.ok(!f.content.includes("l2000\n"));
});

test("mentionText: 0-based IDE lines -> @path#L", () => {
	assert.equal(mentionText({ filePath: "/p/a.ts", lineStart: 4, lineEnd: 9 }, "/p"), "@a.ts#L5-10 ");
	assert.equal(mentionText({ filePath: "/p/a.ts", lineStart: 4, lineEnd: 4 }, "/p"), "@a.ts#L5 ");
	assert.equal(mentionText({ filePath: "/p/a.ts" }, "/p"), "@a.ts ");
});

test("IdeEditor: chip at the start of the top border, yields while busy, Esc dismisses", async () => {
	const { IdeEditor } = await import("../extensions/ide.ts");
	const keybindings = { matches: (d: string, k: string) => k === "app.interrupt" && d === "\x1b", getKeys: () => [] };
	const id = (s: string) => s;
	const theme = { borderColor: id, selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id } };
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
	let chip: { text: string; dim: boolean } | undefined = { text: "⧉ 3 lines selected", dim: false };
	let dismissed = 0;
	const ed = new IdeEditor(tui as any, theme as any, keybindings as any, () => chip, () => dismissed++);
	const top = () => ed.render(40)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal(top(), `── ⧉ 3 lines selected ${"─".repeat(40 - 2 - 20)}`);

	ed.handleInput("\x1b");
	assert.equal(dismissed, 1); // idle + attachable chip: Esc dismisses
	chip = { text: "⧉ 3 lines selected", dim: true };
	ed.handleInput("\x1b");
	assert.equal(dismissed, 1); // already dim: Esc falls through

	chip = { text: "⧉ 3 lines selected", dim: false };
	ed.setWorkingStatusIndicator({ renderInBorder: () => "", renderSpinnerInBorder: () => "" } as any);
	assert.equal(top(), "─".repeat(40)); // busy: default border
	ed.handleInput("\x1b");
	assert.equal(dismissed, 1); // busy: Esc keeps interrupting
	ed.setWorkingStatusIndicator(undefined);
	chip = undefined;
	assert.equal(top(), "─".repeat(40));
});

test("diagnostics: diff against baseline and Claude Code-style listing", () => {
	const d = (message: string, line: number, severity = "Error") => ({ message, severity, source: "ts", code: 2322, range: { start: { line, character: 4 }, end: { line, character: 9 } } });
	const before = [d("old", 1)];
	const now = [d("old", 1), d("new one", 9), d("warn", 2, "Warning")];
	assert.deepEqual(newDiagnostics(before, now).map((x) => x.message), ["new one", "warn"]);
	assert.deepEqual(newDiagnostics(now, now), []);

	const text = formatDiagnostics([{ uri: "file:///p/src/a.ts", diagnostics: newDiagnostics(before, now) }, { uri: "file:///p/b.ts", diagnostics: [] }], "/p");
	assert.equal(text, "src/a.ts:\n  ✗ [Line 10:5] new one [2322] (ts)\n  ⚠ [Line 3:5] warn [2322] (ts)");
	assert.match(formatDiagnostics([{ uri: "file:///p/a.ts", diagnostics: [d("x".repeat(50), 0)] }], "/p", 30), /…\[truncated\]$/);

	assert.deepEqual(parseDiagnostics({ content: [{ type: "text", text: JSON.stringify([{ uri: "file:///a", diagnostics: [] }]) }] }), [{ uri: "file:///a", diagnostics: [] }]);
	assert.deepEqual(parseDiagnostics({ content: [{ type: "text", text: "Timeout getting diagnostics" }] }), []); // JetBrains
	assert.equal(uriToPath("file:///p/a%20b.ts"), "/p/a b.ts");
});

test("ancestorPids: includes our parent chain", () => {
	const a = ancestorPids(process.pid);
	assert.ok(a.has(process.pid) && a.has(process.ppid));
});
