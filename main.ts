// main.ts is mend, the CLI SPEC.md specifies. It implements every section of SPEC.md:
// the command line, the output and exit codes, safe paths, format detection, JSON edits and
// the all-or-nothing write (sections 1 to 4, 9 and 10), matching lines at three tiers
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches
// (section 8). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's text as lines (SPEC section 3): its line break, its lines, whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitText(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinText(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Matching lines (SPEC section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length - from) return out;
  const first = tierKey(o[0], tier);
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (tierKey(lines[i], tier) !== first) continue;
    let good = true;
    for (let j = 1; j < o.length; j += 1) {
      if (tierKey(lines[i + j], tier) !== tierKey(o[j], tier)) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. noNL is set by a `\` line after it (unified only). */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNL: boolean;
}

/**
 * The lines N writes when O matched the file at `pos` at `tier`: context lines are the file's
 * own matched lines, other lines are re-indented at tier 2 (SPEC section 5).
 */
function buildN(items: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const oItems = items.filter((it) => it.kind !== 'add');
  const p = oItems.length > 0 ? leadingWS(oItems[0].text) : '';
  const f = leadingWS(fileLines[pos]);
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'del') {
      oIdx += 1;
      continue;
    }
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]);
      oIdx += 1;
      continue;
    }
    let t = it.text;
    if (tier === 2 && oItems.length > 0 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

function lastCtxAdd(items: BodyItem[]): BodyItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind !== 'del') return items[i];
  }
  return undefined;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Edit = (tree: Tree) => { move?: [string, string] } | void;

/** Unified diffs (SPEC section 6). */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0].trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

/** Apply a section's hunks in order to a file's lines, tracking the drift d (SPEC section 6). */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const o = h.items.filter((it) => it.kind !== 'add').map((it) => it.text);
    if (o.length === 0) {
      const n = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      if (n.length === 0) continue;
      const at = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const isEnd = at === cur.lines.length;
      const last = lastCtxAdd(h.items);
      const finalBreak = isEnd ? (last === undefined ? true : !last.noNL) : cur.finalBreak;
      const lines = [...cur.lines];
      lines.splice(at, 0, ...n);
      cur = { lines, br: cur.br, finalBreak };
      d += n.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0];
    let best = Math.abs(pos - target);
    for (const q of found.positions) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const runsToEnd = pos + o.length === cur.lines.length;
    const n = buildN(h.items, cur.lines, pos, found.tier);
    let finalBreak = cur.finalBreak;
    if (runsToEnd) {
      const last = lastCtxAdd(h.items);
      finalBreak = last === undefined ? cur.lines.length - o.length > 0 : !last.noNL;
    }
    const lines = [...cur.lines];
    lines.splice(pos, o.length, ...n);
    cur = { lines, br: cur.br, finalBreak };
    d += n.length - o.length;
  }
  return cur;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld !== undefined ? sec.gitOld : null;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew !== undefined ? sec.gitNew : null;
  return (tree) => {
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const p = newP as string;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            plus.push(it.text);
            noNL = it.noNL;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const p = oldP as string;
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP as string) !== null) throw new Fail('exists', newP as string);
    const out = joinText(applyHunks(splitText(t), sec.hunks, strict, p));
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP as string, out);
      return { move: [p, newP as string] };
    }
    tree.now.set(p, out);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (): Section => {
    const s: Section = { create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.gitOld = m[1];
      s.gitNew = m[2];
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1], 10), items: [] };
      i += 1;
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i += 1;
        } else break;
      }
      for (const bl of raw) {
        if (bl.startsWith('\\')) {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.noNL = true;
        } else if (bl === '') {
          hunk.items.push({ kind: 'ctx', text: '', noNL: false });
        } else {
          hunk.items.push({ kind: bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'del' : 'add', text: bl.slice(1), noNL: false });
        }
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1];
        if (last.kind === 'ctx' && last.text === '' && !last.noNL) hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(l.slice(4));
          cur.pairNew = headerPath(lines[i + 1].slice(4));
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.pairOld = headerPath(l.slice(4));
      s.pairNew = headerPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** SEARCH/REPLACE blocks (SPEC section 7). */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const st = splitText(t);
    const found = findTier(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0];
    const p = leadingWS(oldLines[0]);
    const f = leadingWS(st.lines[pos]);
    const out = newLines.map((l) => (found.tier === 2 && l.trim() !== '' && l.startsWith(p) ? f + l.slice(p.length) : l));
    const lines = [...st.lines];
    lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinText({ lines, br: st.br, finalBreak: st.finalBreak }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** V4A patches (SPEC section 8). */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function isSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = splitText(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const f = findTier(st.lines, [ch.anchor], strict, cursor);
        if (f === null) throw new Fail('no-match', p);
        cursor = f.positions[0] + 1;
      }
      const o = ch.items.filter((it) => it.kind !== 'add').map((it) => it.text);
      if (o.length === 0) {
        const n = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = ch.eof ? st.lines.length : cursor;
        const lines = [...st.lines];
        lines.splice(at, 0, ...n);
        st = { lines, br: st.br, finalBreak: st.finalBreak };
        cursor = at + n.length;
        continue;
      }
      const f = findTier(st.lines, o, strict, cursor);
      if (f === null) throw new Fail('no-match', p);
      let pos = -1;
      for (const q of f.positions) {
        if (ch.eof && q + o.length !== st.lines.length) continue;
        pos = q;
        break;
      }
      if (pos < 0) throw new Fail('no-match', p);
      const n = buildN(ch.items, st.lines, pos, f.tier);
      const lines = [...st.lines];
      lines.splice(pos, o.length, ...n);
      st = { lines, br: st.br, finalBreak: st.finalBreak };
      cursor = pos + n.length;
    }
    const out = joinText(st);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      return { move: [p, moveTo] };
    }
    tree.now.set(p, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const collectSection = (): { text: string; idx: number }[] => {
    const body: { text: string; idx: number }[] = [];
    while (i < end && !isSectionStart(lines[i])) {
      body.push({ text: lines[i], idx: i });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1].text)) body.pop();
    return body;
  };
  while (i < end) {
    const l = lines[i];
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const body = collectSection();
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      const body = collectSection();
      for (const b of body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const hdrIdx = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < end && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i += 1;
      }
      const body = collectSection();
      const chunks: VChunk[] = [];
      let j = 0;
      let cur: VChunk | null = null;
      const isBodyLine = (t: string): boolean => t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+');
      while (j < body.length) {
        const b = body[j];
        if (b.text.startsWith('@@')) {
          cur = { anchor: b.text.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
          j += 1;
          continue;
        }
        if (b.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.idx + 1}`);
          cur.eof = true;
          cur = null;
          j += 1;
          continue;
        }
        if (blank(b.text) && cur === null && chunks.length > 0) {
          j += 1;
          continue;
        }
        if (isBodyLine(b.text)) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.idx + 1}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          cur.items.push(
            b.text === ''
              ? { kind: 'ctx', text: '', noNL: false }
              : { kind: b.text[0] === ' ' ? 'ctx' : b.text[0] === '-' ? 'del' : 'add', text: b.text.slice(1), noNL: false },
          );
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hdrIdx + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined && m.move !== undefined) moves.push(m.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!consumed.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
