// Fast drop-in for makefun-site 1.0.0: run(input) returns byte-identical output.
// Strategy: single-pass Markdown with no regex in hot paths, manual front-matter
// parsing, cached slugify, and templates compiled once per case into JS functions
// (new Function) with array-push output; includes whose result depends only on
// case-stable values (site/tags/recent/loop element) are memoized per run.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const WS_RE = /\s/;
const INLINE_SPECIAL = /[\\`*\[&<>"']/;
const NONASCII_RE = /[^\x00-\x7F]/;
const MARKS_RE = /\p{M}/gu;
const RESERVED = ['posts', 'tags', 'page'];

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function esc(s) { return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s; }

/* ------------------------------------------------------------------ slug */

const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (NONASCII_RE.test(text)) plain = text.normalize('NFKD').replace(MARKS_RE, '');
  let out = '';
  let gap = false;
  if (plain === text && !NONASCII_RE.test(text)) {
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let keep = null;
      if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out[e - 1] === '-') e--;
  if (e !== out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out;
  do { out = slug + '-' + n++; } while (taken.has(out));
  taken.add(out);
  return out;
}

function longDate(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) : WS_RE.test(text[i]);
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

/* ------------------------------------------------------------- front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { e: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { e: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { e: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { v: out };
  }
  if (raw[0] === '[') return { e: 'a bare string opens on [' };
  return { v: raw };
}

function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugVal(s) {
  if (s.length === 0 || s.length > 64) return false;
  let i = 0;
  const n = s.length;
  const alnum = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
  while (true) {
    if (i >= n || !alnum(s.charCodeAt(i))) return false;
    while (i < n && alnum(s.charCodeAt(i))) i++;
    if (i >= n) return true;
    if (s.charCodeAt(i) !== 45) return false;
    i++;
    if (i >= n || !alnum(s.charCodeAt(i))) return false;
  }
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'e' in s ? { e: 'key "' + key + '": ' + s.e } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? +raw.slice(0, 4) : 0;
      const mo = ok ? +raw.slice(5, 7) : 0;
      const d = ok ? +raw.slice(8, 10) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { e: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { v: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { e: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { v: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { v: tags };
    }
    case 'draft':
      return raw === 'true' ? { v: true } : raw === 'false' ? { v: false } : { e: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { v: raw } : { e: 'key "layout": not a template name' };
    case 'slug':
      return isSlugVal(raw) ? { v: raw } : { e: 'key "slug": not a slug' };
    default:
      return { e: 'unknown key "' + key + '"' };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function parseFrontMatter(text) {
  if (text !== '---' && text.slice(0, 4) !== '---\n') return { error: 'no front matter' };
  let closeStart = -1;
  let closeAfter = -1;
  let j = text.indexOf('\n---', 3);
  while (j !== -1) {
    const a = j + 4;
    if (a === text.length || text[a] === '\n') { closeStart = j + 1; closeAfter = a; break; }
    j = text.indexOf('\n---', j + 1);
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart - 1);
  const body = closeAfter < text.length ? text.slice(closeAfter + 1) : '';
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (isBlankLine(line) || line[0] === '#') continue;
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      i++;
    }
    if (i === 0 || line[i] !== ':') return { error: 'line ' + (k + 2) + ' is not "key: value"' };
    const key = line.slice(0, i);
    let raw;
    if (i + 1 === line.length) raw = '';
    else if (line[i + 1] === ' ') raw = line.slice(i + 2);
    else return { error: 'line ' + (k + 2) + ' is not "key: value"' };
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('e' in v) return { error: v.e };
    data[key] = v.v;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

/* ---------------------------------------------------------------- Markdown */

function isEscapable(c) {
  return c === '\\' || c === '`' || c === '*' || c === '_' || c === '[' || c === ']' || c === '(' || c === ')' || c === '#' || c === '+' || c === '-' || c === '.' || c === '!' || c === '>';
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  for (let k = i; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return null;
  }
  return line.slice(3, i);
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  const text = trimLine(line.slice(n + 1));
  if (text === '') return null;
  return { depth: n, text };
}

function isHR(line) {
  if (!((line[0] === '-' && line[1] === '-' && line[2] === '-') || (line[0] === '*' && line[1] === '*' && line[2] === '*'))) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9 && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0) return null;
  if (i < 9 && line[i] >= '0' && line[i] <= '9') return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  return !WS_RE.test(line[i]);
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inlineTo(s, link, out) {
  if (!INLINE_SPECIAL.test(s)) { out.push(s); return; }
  let i = 0;
  const n = s.length;
  let run = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isEscapable(s[i + 1])) {
      if (run < i) out.push(s.slice(run, i));
      out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (run < i) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineTo(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<em>');
        inlineTo(s.slice(i + 1, j), link, out);
        out.push('</em>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      if (k !== -1 && s[k + 1] === '(') {
        const m = s.indexOf(')', k + 2);
        const target = m === -1 ? '' : s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          if (run < i) out.push(s.slice(run, i));
          out.push('<a href="', esc(link(target)), '">');
          inlineTo(s.slice(i + 1, k), link, out);
          out.push('</a>');
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (run < i) out.push(s.slice(run, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (run < n) out.push(s.slice(run));
}

function inlineStr(s, link) {
  if (!INLINE_SPECIAL.test(s)) return s;
  const o = [];
  inlineTo(s, link, o);
  return o.join('');
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const parts = ['<pre><code'];
      if (fence !== '') { parts.push(' class="language-', esc(fence), '"'); }
      parts.push('>');
      for (let k = 0; k < body.length; k++) { parts.push(esc(body[k]), '\n'); }
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.slice(1);
        if (l[0] === ' ') l = l.slice(1);
        body.push(l);
      }
      const ls = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inlineStr(ls.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrdered = o0 !== null;
      const start = isOrdered ? Number(o0.num) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.rest)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const parts = [isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>', '\n'];
      for (let k = 0; k < items.length; k++) {
        parts.push('<li>', inlineStr(items[k].join('\n'), link), '</li>\n');
      }
      parts.push('</' + tag + '>');
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt };
}

/* --------------------------------------------------------------- templates */

class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/* First names a template's output can depend on (own for-bindings excluded). */
function depsOf(name, asts, seen) {
  const ast = asts.get(name);
  if (ast === undefined || seen.has(name)) return new Set();
  const seen2 = new Set(seen);
  seen2.add(name);
  const out = new Set();
  walkDeps(ast, new Set(), out, asts, seen2);
  return out;
}
function walkDeps(nodes, bound, out, asts, seen) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      if (n.kind === 'if') {
        walkDeps(n.then, bound, out, asts, seen);
        if (n.else !== null) walkDeps(n.else, bound, out, asts, seen);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      walkDeps(n.body, b2, out, asts, seen);
    } else if (n.kind === 'include') {
      for (const d of depsOf(n.name, asts, seen)) {
        if (!bound.has(d)) out.add(d);
      }
    }
  }
}

/* Longest include chain inside a template (Infinity on a cycle). */
function depthOf(name, asts, seen) {
  const ast = asts.get(name);
  if (ast === undefined) return 0;
  if (seen.has(name)) return Infinity;
  const seen2 = new Set(seen);
  seen2.add(name);
  let m = 0;
  for (const n of ast) {
    if (n.kind === 'include') {
      const d = depthOf(n.name, asts, seen2);
      if (d === Infinity) return Infinity;
      if (1 + d > m) m = 1 + d;
    } else if (n.kind === 'for') {
      const d = depthOfNodes(n.body, asts, seen2);
      if (d > m) m = d;
    } else if (n.kind === 'if') {
      const d = Math.max(depthOfNodes(n.then, asts, seen2), n.else === null ? 0 : depthOfNodes(n.else, asts, seen2));
      if (d > m) m = d;
    }
  }
  return m;
}
function depthOfNodes(nodes, asts, seen) {
  let m = 0;
  for (const n of nodes) {
    if (n.kind === 'include') {
      const d = depthOf(n.name, asts, seen);
      if (d === Infinity) return Infinity;
      if (1 + d > m) m = 1 + d;
    } else if (n.kind === 'for') {
      const d = depthOfNodes(n.body, asts, seen);
      if (d > m) m = d;
    } else if (n.kind === 'if') {
      const d = Math.max(depthOfNodes(n.then, asts, seen), n.else === null ? 0 : depthOfNodes(n.else, asts, seen));
      if (d > m) m = d;
    }
  }
  return m;
}

/* ------------------------------------------------------- template compiler */

function lk(S, name) {
  for (let i = S.length - 1; i >= 0; i--) {
    const o = S[i];
    if (Object.hasOwn(o, name)) return o[name];
  }
  return undefined;
}
function g(v, seg) {
  return (v === null || typeof v !== 'object') ? undefined : (Object.hasOwn(v, seg) ? v[seg] : undefined);
}
function tr(v) {
  return Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== false && v !== '' && v !== 0);
}
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}
function ev(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return esc(txt(v));
}
function rv(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return txt(v);
}
function inc(H, C, name, out, S, d) {
  if (d >= 8) return;
  const f = C.F[name];
  if (f === undefined) return;
  const deps = C.deps[name];
  if (deps === null || d + C.md[name] > 8) { f(H, out, S, d + 1, C); return; }
  let k = name;
  for (let i = 0; i < deps.length; i++) {
    const v = H.lk(S, deps[i]);
    k += '\x00';
    if (v !== null && typeof v === 'object') {
      let id = C.ids.get(v);
      if (id === undefined) { id = ++C.nextId; C.ids.set(v, id); }
      k += 'o' + id;
    } else if (typeof v === 'string') k += 's' + v.length + ':' + v;
    else if (typeof v === 'number') k += 'n' + v;
    else if (typeof v === 'boolean') k += v ? 'b1' : 'b0';
    else if (v === null) k += 'z';
    else k += 'u';
  }
  const hit = C.memo.get(k);
  if (hit !== undefined) { out.push(hit); return; }
  const st = out.length;
  f(H, out, S, d + 1, C);
  const s = out.slice(st).join('');
  C.memo.set(k, s);
  out.length = st;
  out.push(s);
}
const H = { lk, g, tr, txt, ev, rv, inc };

function pathExpr(path) {
  let e = 'H.lk(S,' + JSON.stringify(path[0]) + ')';
  for (let k = 1; k < path.length; k++) e = 'H.g(' + e + ',' + JSON.stringify(path[k]) + ')';
  return e;
}

function gen(nodes, code, ctr) {
  for (const n of nodes) {
    if (n.kind === 'text') code.push('out.push(' + JSON.stringify(n.text) + ');');
    else if (n.kind === 'var' || n.kind === 'raw') code.push('out.push(H.' + (n.kind === 'var' ? 'ev' : 'rv') + '(' + pathExpr(n.path) + '));');
    else if (n.kind === 'if') {
      code.push('if(' + (n.not ? '!' : '') + 'H.tr(' + pathExpr(n.path) + ')){');
      gen(n.then, code, ctr);
      if (n.else !== null) { code.push('}else{'); gen(n.else, code, ctr); }
      code.push('}');
    } else if (n.kind === 'for') {
      const u = ctr.n++;
      code.push('{const _x' + u + '=' + pathExpr(n.path) + ';if(Array.isArray(_x' + u + ')){const _f' + u + '={};const _l' + u + '={index:0,first:false,last:false,length:_x' + u + '.length};_f' + u + '.loop=_l' + u + ';S.push(_f' + u + ');for(let _k' + u + '=0;_k' + u + '<_x' + u + '.length;_k' + u + '++){_f' + u + '.' + n.name + '=_x' + u + '[_k' + u + '];_f' + u + '.loop=_l' + u + ';_l' + u + '.index=_k' + u + '+1;_l' + u + '.first=_k' + u + '===0;_l' + u + '.last=_k' + u + '===_x' + u + '.length-1;');
      gen(n.body, code, ctr);
      code.push('}S.pop();}}');
    } else if (n.kind === 'include') {
      code.push('H.inc(H,C,' + JSON.stringify(n.name) + ',out,S,d);');
    }
  }
}

function compile(ast) {
  const code = [];
  gen(ast, code, { n: 0 });
  return new Function('H', 'out', 'S', 'd', 'C', code.join('\n'));
}

/* -------------------------------------------------------------------- build */

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date === undefined ? '' : s.data.date, date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function run(input) {
  const report = [];
  const asts = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const C = { F: {}, deps: {}, md: {}, memo: new Map(), ids: new WeakMap(), nextId: 0 };
  for (const name of asts.keys()) {
    const deps = depsOf(name, asts, new Set());
    let memoizable = true;
    for (const d of deps) {
      if (d === 'page' || d === 'tag' || d === 'posts' || d === 'pager' || d === 'loop') { memoizable = false; break; }
    }
    C.deps[name] = memoizable ? [...deps] : null;
    C.md[name] = depthOf(name, asts, new Set());
    C.F[name] = compile(asts.get(name));
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let k = 0; k < RESERVED.length; k++) {
      const d = RESERVED[k];
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout !== undefined ? s.data.layout : (s.post ? 'post' : 'page');
    if (!asts.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (isScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags === undefined ? [] : s.data.tags;
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const slug = slugify(name);
      const t = bySlug.get(slug);
      s.tagRefs.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => (y.posts.length - x.posts.length) || cmp(x.slug, y.slug));

  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const f = C.F[name];
    if (f === undefined) return null;
    const out = [];
    const root = { site, tags: allTags, recent };
    for (const k in vars) root[k] = vars[k];
    f(H, out, [root], 0, C);
    return out.join('');
  };
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer === undefined || s.newer === null ? null : s.newer),
      older: linkOf(s.older === undefined || s.older === null ? null : s.older),
      is_post: s.post,
    };
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(cmp);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
