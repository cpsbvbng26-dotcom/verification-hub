/* ワークフローの YAML を読む、小さな読み手。外のパッケージを使わない。
 *
 *     const { parse } = require('./yaml.js');
 *     parse(text)   // オブジェクト・配列・文字列・null
 *
 * 読むのは、運営者のリポジトリのワークフローが使う形だけである。
 *   ブロックの対応と並び、「- 鍵: 値」で始まる並びの要素、{ } と [ ] の流れの形、
 *   一重と二重の引用符、| と > のブロックの文字列（- と + の後ろ付きを含む）、注釈。
 * スカラーはどれも文字列で返す（22 も '22' も "22" になる）。アンカー・別名・タグ・複数の文書は読まない。
 * 読めない形に出会えば、行の番号を添えて投げる。読めないものを、読めたことにしない。 */

'use strict';

function fail(n, why) {
  throw new Error('YAML の ' + (n + 1) + ' 行目：' + why);
}

/* 引用符の外にある「 #」から後ろを注釈として外す。 */
function stripComment(s) {
  let q = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (q === "'" && c === "'" && s[k + 1] === "'") { k++; continue; }
      if (q === '"' && c === '\\') { k++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { if (k === 0 || /[\s\[{,:]/.test(s[k - 1])) q = c; continue; }
    if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

function unquote(s, n) {
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) fail(n, '閉じない一重の引用符');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) fail(n, '閉じない二重の引用符');
    return s.slice(1, -1).replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[c] !== undefined ? { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[c] : fail(n, '読まない逃がし文字 \\' + c)));
  }
  return s;
}

/* 流れの形（{ a: b, c: [d, 'e'] }）。 */
function flow(src, n) {
  let p = 0;
  const ws = () => { while (p < src.length && /\s/.test(src[p])) p++; };
  const scalar = (stops) => {
    ws();
    if (src[p] === "'" || src[p] === '"') {
      const q = src[p];
      let k = p + 1;
      for (; k < src.length; k++) {
        if (q === "'" && src[k] === "'" && src[k + 1] === "'") { k++; continue; }
        if (q === '"' && src[k] === '\\') { k++; continue; }
        if (src[k] === q) break;
      }
      if (k >= src.length) fail(n, '閉じない引用符');
      const s = unquote(src.slice(p, k + 1), n);
      p = k + 1;
      return s;
    }
    let k = p;
    while (k < src.length && !stops.includes(src[k])) k++;
    const s = src.slice(p, k).trim();
    p = k;
    return s;
  };
  const value = () => {
    ws();
    if (src[p] === '{') {
      p++;
      const o = {};
      ws();
      if (src[p] === '}') { p++; return o; }
      for (;;) {
        const k = scalar([':', ',', '}']);
        ws();
        if (src[p] !== ':') fail(n, '流れの対応に「:」が無い');
        p++;
        o[k] = value();
        ws();
        if (src[p] === ',') { p++; continue; }
        if (src[p] === '}') { p++; return o; }
        fail(n, '流れの対応が閉じない');
      }
    }
    if (src[p] === '[') {
      p++;
      const a = [];
      ws();
      if (src[p] === ']') { p++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (src[p] === ',') { p++; continue; }
        if (src[p] === ']') { p++; return a; }
        fail(n, '流れの並びが閉じない');
      }
    }
    return scalar([',', '}', ']']);
  };
  const v = value();
  ws();
  if (p !== src.length) fail(n, '流れの形の後ろに余り');
  return v;
}

function scalarOrFlow(s, n) {
  if (s.startsWith('{') || s.startsWith('[')) return flow(s, n);
  if (/^[&*!]/.test(s)) fail(n, 'アンカー・別名・タグは読まない');
  if (s.startsWith("'") || s.startsWith('"')) return unquote(s, n);
  return s;
}

const KEY = /^((?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s#'"{\[\]},&*!|>-][^:]*?|-[^\s:][^:]*?))\s*:(?:\s+(.*)|)$/;

function parse(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.some((l) => /^\t/.test(l) || /^ *\t/.test(l))) fail(lines.findIndex((l) => /^ *\t/.test(l)), '字下げにタブ');
  let i = 0;
  const indentOf = (l) => l.length - l.replace(/^ +/, '').length;
  const skip = (l) => { const t = l.trim(); return t === '' || t.startsWith('#') || t === '---'; };
  const next = () => { while (i < lines.length && skip(lines[i])) i++; return i < lines.length ? lines[i] : null; };

  function blockScalar(head, parentIndent) {
    const m = /^([|>])([+-]?)$/.exec(head);
    if (!m) fail(i - 1, 'ブロックの文字列の印「' + head + '」');
    const body = [];
    let ind = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { body.push(''); i++; continue; }
      const li = indentOf(l);
      if (ind === null) { if (li <= parentIndent) break; ind = li; }
      if (li < ind) break;
      body.push(l.slice(ind));
      i++;
    }
    /* 末尾の空行は文字列に入れない。後ろ付きの印は、- と、印なし（一つの改行）だけを読む。 */
    while (body.length && body[body.length - 1] === '') body.pop();
    let s;
    if (m[1] === '|') s = body.join('\n');
    else {
      s = '';
      body.forEach((l, k) => { s += (k === 0 ? '' : (l === '' || body[k - 1] === '' ? '\n' : ' ')) + l; });
      s = s.replace(/\n /g, '\n');
    }
    if (m[2] === '+') fail(i - 1, '後ろ付きの + は読まない');
    return m[2] === '-' ? s : s + '\n';
  }

  function valueAfterKey(rest, ind, n) {
    if (rest === undefined || rest === '') {
      const nl = next();
      if (nl === null) return null;
      const li = indentOf(nl);
      if (li > ind) return block(li);
      if (li === ind && /^- |^-$/.test(nl.slice(li))) return seq(li);
      return null;
    }
    if (/^[|>][+-]?$/.test(rest)) return blockScalar(rest, ind);
    return scalarOrFlow(rest, n);
  }

  function map(ind) {
    const o = {};
    for (;;) {
      const l = next();
      if (l === null) break;
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) fail(i, '字下げが合わない');
      const t = stripComment(l.slice(ind));
      if (/^- |^-$/.test(t)) break;
      const m = KEY.exec(t);
      if (!m) fail(i, '鍵と値の形でない「' + t.slice(0, 30) + '」');
      const key = unquote(m[1], i);
      if (Object.prototype.hasOwnProperty.call(o, key)) fail(i, '同じ鍵「' + key + '」が二つ');
      const n = i;
      i++;
      o[key] = valueAfterKey(m[2] === undefined ? undefined : m[2].trim(), ind, n);
    }
    return o;
  }

  function seq(ind) {
    const a = [];
    for (;;) {
      const l = next();
      if (l === null) break;
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) fail(i, '並びの字下げが合わない');
      const t0 = l.slice(ind);
      if (!/^- |^-$/.test(t0)) break;
      const after = t0.slice(1);
      const content = after.replace(/^ +/, '');
      const cind = ind + 1 + (after.length - content.length);
      const t = stripComment(content);
      if (t === '') { i++; a.push(block(ind + 1)); continue; }
      if (KEY.test(t) && !/^['"]/.test(t) || /^['"][^'"]*['"]\s*:(\s|$)/.test(t)) {
        lines[i] = ' '.repeat(cind) + content;
        a.push(map(cind));
        continue;
      }
      const n = i;
      i++;
      a.push(/^[|>][+-]?$/.test(t) ? blockScalar(t, ind) : scalarOrFlow(t, n));
    }
    return a;
  }

  function block(ind) {
    const l = next();
    if (l === null) return null;
    const li = indentOf(l);
    if (li < ind) return null;
    return /^- |^-$/.test(l.slice(li)) ? seq(li) : map(li);
  }

  const v = block(0);
  if (next() !== null) fail(i, '読み残し');
  return v;
}

module.exports = { parse };
