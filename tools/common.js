/* 共通の検査のうち、どのリポジトリにも同じ物差しを当てるもの。
 *
 *     node tools/common.js <置き場>
 *
 * <置き場> の下に、リポジトリが名ごとに並んでいる（<置き場>/<名>）。
 * ハブの置き方では、目録のすべてのリポジトリがそろっていなければ落ちる。写しの置き方では、呼んだリポジトリだけを見る。
 *
 *   写し    正本を持つリポジトリ（目録の entrance）のファイルと、各リポジトリの写しが一字一句同じ（目録の copies）。
 *           正本と同じなのに目録に載せていない写しも落とす。ハブの置き方だけ。
 *   走査    追跡しているテキストのファイルに、許していないメールアドレスが無い。許すものは、正本を持つリポジトリの
 *           verification/check_secrets.js の表から読む（ここに書き写さない）。写しの置き方では、一つも許さない。
 *           Markdown と TOML に、正本を持つリポジトリの verification/check_text.js の CONJUGATION の形が無い（ハブの置き方だけ）。
 *   --only <名> を付けると、そのリポジトリだけを走査する（横断の検査を回さないリポジトリ）。
 *   つながり Markdown のリンクが、そのリポジトリの追跡しているファイルかディレクトリを指す。
 *           https://github.com/<持ち主>/<名>/blob/main/… と tree/main/… は、目録にあるリポジトリのファイルを指す。
 *
 * 落ちたものは、ファイルと行の番号を添えて並べる。メールアドレスそのものは出さない（どのファイルの何行目かだけ）。 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

/* 形そのものを書くと、このファイルが走査に掛かる。だから切って繋ぐ。 */
const MAIL = new RegExp('[A-Za-z0-9._%+-]+' + '@' + '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}', 'g');
const sha256 = (x) => require('crypto').createHash('sha256').update(x, 'utf8').digest('hex');
const BINARY = /\.(pdf|png|jpe?g|gif|ico|webp|woff2?|ttf|otf|zip|gz|xz|bz2|xlsx?|docx?|pptx?|npz|npy|pkl|sqlite|db)$/i;

function tracked(dir) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  } catch (e) {
    return null;
  }
}

function textOf(dir, f) {
  if (BINARY.test(f)) return null;
  const p = path.join(dir, f);
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const b = fs.readFileSync(p);
  if (b.includes(0)) return null;
  return b.toString('utf8');
}

/* 正本の表を読む。表が読めなければ null（落とす側で扱う）。 */
function mailRules(src) {
  const a = /const ALLOWED_MAIL = \[([^\]]*)\];/.exec(src || '');
  const r = /const ALLOWED_MAIL_RE = \/((?:[^/\\\n]|\\.)+)\/([a-z]*);/.exec(src || '');
  if (!a || !r) return null;
  const list = [...a[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return { list, re: new RegExp(r[1], r[2]) };
}

/* 壊れた活用のうち、横断で止める形。cpsbvbng26 の横断の検査（7.18）と同じく、音便に「ました」を繋いだ形・
 * 助詞を活用させた形・否定の「ない」を替えた形だけを、表から読む。である調へ書き換えたときの形は、
 * 正誤の記録が誤りの証拠として引いているので、横断では止めない（そのリポジトリの検査が見る）。 */
function conjugation(src) {
  const at = (src || '').indexOf('const CONJUGATION = [');
  if (at < 0) return null;
  const end = src.indexOf('\n];', at);
  const body = src.slice(at, end < 0 ? src.length : end);
  const out = [...body.matchAll(/\{ re: \/([^/]+)\/, right: '[^']+', note: '(?:「[^」]+」＋|助詞|否定の「ない」)/g)].map((m) => m[1]);
  return out.length && out.every((w) => !/[\\^$.*+?()[\]{}|]/.test(w)) ? out : null;
}

/* Markdown のリンクの行き先を、囲みとコードの中を除いて拾う。[行の番号, 行き先]。 */
function linksOf(text) {
  const out = [];
  let fence = null, comment = false;
  text.split('\n').forEach((line, k) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f && !comment) { if (fence === null) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (fence !== null) return;
    /* HTML の注釈（<!-- -->）の中は、描かれないので見ない。行をまたぐ注釈も同じ。 */
    let l = '';
    let rest = line;
    while (rest.length) {
      if (comment) { const e = rest.indexOf('-->'); if (e < 0) { rest = ''; break; } comment = false; rest = rest.slice(e + 3); continue; }
      const b = rest.indexOf('<!--');
      if (b < 0) { l += rest; break; }
      l += rest.slice(0, b);
      comment = true;
      rest = rest.slice(b + 4);
    }
    l = l.replace(/`[^`]*`/g, '');
    for (const m of l.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push([k + 1, m[1]]);
    const ref = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/.exec(l);
    if (ref) out.push([k + 1, ref[1]]);
  });
  return out;
}

function check(root, ctx) {
  const bad = { 写し: [], 走査: [], つながり: [] };
  const n = { 写し: 0, ファイル: 0, リンク: 0 };
  const files = {};
  for (const r of ctx.repos) {
    const dir = path.join(root, r);
    files[r] = fs.existsSync(dir) ? tracked(dir) : null;
    if (files[r] === null) bad.走査.push(r + '：リポジトリが無いか、git で読めない');
  }
  const has = (r) => files[r] !== null && files[r] !== undefined;
  const sets = {};
  const setOf = (r) => {
    if (!sets[r]) {
      const s = new Set(files[r]);
      for (const f of files[r]) { const parts = f.split('/'); for (let k = 1; k < parts.length; k++) s.add(parts.slice(0, k).join('/') + '/'); }
      sets[r] = s;
    }
    return sets[r];
  };

  /* 写し。 */
  if (ctx.copies) {
    const E = ctx.copies.entrance;
    for (const r of ctx.scan || ctx.repos) {
      if (!has(r) || !has(E)) continue;
      for (const f of ctx.copies.paths) {
        const want = ctx.copies.listed[r] || [];
        const p = path.join(root, r, f), q = path.join(root, E, f);
        const exists = fs.existsSync(p), same = exists && fs.existsSync(q) && fs.readFileSync(p).equals(fs.readFileSync(q));
        if (want.includes(f)) { n.写し++; if (!exists) bad.写し.push(r + '/' + f + '：写しが無い'); else if (!same) bad.写し.push(r + '/' + f + '：正本と違う'); }
        else if (same && r !== E) bad.写し.push(r + '/' + f + '：正本と同じだが、目録の copies に無い');
      }
    }
  }

  /* 走査とつながり。 */
  const GH = new RegExp('^https://github\\.com/' + ctx.owner.replace(/[.-]/g, '\\$&') + '/([A-Za-z0-9._-]+)/(?:blob|tree)/(?:main|HEAD)/([^?#]*)');
  for (const r of ctx.scan || ctx.repos) {
    if (!has(r)) continue;
    const dir = path.join(root, r);
    for (const f of files[r]) {
      const t = textOf(dir, f);
      if (t === null) continue;
      n.ファイル++;
      const lines = t.split('\n');
      if (!(ctx.skipMail || []).includes(r + '/' + f)) {
        lines.forEach((line, k) => {
          if (/\.ics$/.test(f) && /^UID:/.test(line)) return;
          for (const m of line.matchAll(MAIL)) {
            if (/^[(\[]/.test(line.slice(m.index + m[0].length))) continue;
            if (ctx.mail && (ctx.mail.list.includes(m[0]) || ctx.mail.re.test(m[0]))) continue;
            if (ctx.hashes && ctx.hashes[r] && ctx.hashes[r].has(sha256(m[0]))) continue;
            bad.走査.push(r + '/' + f + ':' + (k + 1) + '：許していないメールアドレス');
          }
        });
      }
      if (ctx.conj && /\.(md|toml)$/.test(f) && !(r === ctx.conjFile[0] && f === ctx.conjFile[1])) {
        lines.forEach((line, k) => { for (const w of ctx.conj) if (line.includes(w)) bad.走査.push(r + '/' + f + ':' + (k + 1) + '：壊れた活用'); });
      }
      if (!/\.md$/.test(f)) continue;
      for (const [k, raw] of linksOf(t)) {
        let target = raw;
        const g = GH.exec(target);
        if (g) {
          n.リンク++;
          const [, repo, rest] = g;
          if (!ctx.repos.includes(repo) || !has(repo)) continue;
          let p;
          try { p = decodeURIComponent(rest).replace(/\/$/, ''); } catch (e) { bad.つながり.push(r + '/' + f + ':' + k + '：読めない URL'); continue; }
          if (p !== '' && !setOf(repo).has(p) && !setOf(repo).has(p + '/')) bad.つながり.push(r + '/' + f + ':' + k + '：' + repo + ' に ' + p + ' が無い');
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
        n.リンク++;
        target = target.replace(/[?#].*$/, '');
        let p;
        try { p = decodeURIComponent(target); } catch (e) { bad.つながり.push(r + '/' + f + ':' + k + '：読めない行き先'); continue; }
        const joined = p.startsWith('/') ? p.slice(1) : path.posix.join(path.posix.dirname(f), p);
        const norm = path.posix.normalize(joined).replace(/\/$/, '');
        if (norm === '.' || norm === '') continue;
        if (norm.startsWith('../') || norm === '..') { bad.つながり.push(r + '/' + f + ':' + k + '：リポジトリの外を指す ' + raw); continue; }
        if (!setOf(r).has(norm) && !setOf(r).has(norm + '/')) bad.つながり.push(r + '/' + f + ':' + k + '：無いファイル ' + raw);
      }
    }
  }
  return { bad, n };
}

/* 置き方から、検査の文脈を作る。 */
function context(loaded, me, root) {
  if (loaded.mode === 'self-contained') {
    const x = loaded.entry.mail;
    if (x && (!x.why || !Array.isArray(x.allowed) || !x.allowed.every((h) => /^[0-9a-f]{64}$/.test(h)))) lib.fail('写しの目録の mail の欄');
    return { owner: me.owner, repos: [me.name], copies: null, mail: null, conj: null, hashes: { [me.name]: new Set(x ? x.allowed : []) } };
  }
  const m = loaded.manifest;
  const E = m.entrance;
  const read = (f) => { try { return fs.readFileSync(path.join(root, E, f), 'utf8'); } catch (e) { return null; } };
  const mail = mailRules(read(m.common.mailRules));
  const conj = conjugation(read(m.common.textRules));
  if (!mail) lib.fail(E + '/' + m.common.mailRules + ' から、許すメールアドレスの表が読めない');
  if (!conj) lib.fail(E + '/' + m.common.textRules + ' から、CONJUGATION の表が読めない');
  const repos = Object.keys(m.repos);
  /* リポジトリごとに許す宛先は、宛先そのものではなく SHA-256 で目録に置く（このリポジトリにメールアドレスを書かない）。 */
  const hashes = {};
  for (const r of repos) {
    const x = m.repos[r].mail;
    if (!x) continue;
    if (!x.why || !Array.isArray(x.allowed) || !x.allowed.every((h) => /^[0-9a-f]{64}$/.test(h))) lib.fail(r + ' の mail の欄');
    hashes[r] = new Set(x.allowed);
  }
  return {
    owner: m.owner, repos, mail, conj, hashes, conjFile: [E, m.common.textRules],
    skipMail: [E + '/' + m.common.mailRules],
    copies: { entrance: E, paths: m.common.copies, listed: Object.fromEntries(repos.map((r) => [r, m.repos[r].copies || []])) },
  };
}

if (require.main === module) {
  try {
    const root = process.argv[2];
    if (!root) lib.fail('置き場を一つ渡す');
    const loaded = lib.load(__dirname);
    const me = lib.caller();
    const ctx = context(loaded, me, path.resolve(root));
    /* --only <名>：そのリポジトリだけを走査する。ほかのリポジトリは、写しの正本とリンクの行き先を読むためだけに使う。 */
    const only = process.argv.indexOf('--only');
    if (only > 0) {
      const n = process.argv[only + 1];
      if (!ctx.repos.includes(n)) lib.fail('--only の名が目録に無い');
      ctx.scan = [n];
    }
    const { bad, n } = check(path.resolve(root), ctx);
    const lines = [];
    for (const [k, v] of Object.entries(bad)) {
      console.log((v.length ? '  落  ' : '  通  ') + k + (v.length ? '：' + v.length + ' 件' : ''));
      v.slice(0, 40).forEach((x) => console.log('        ' + x));
      if (v.length > 40) console.log('        ほか ' + (v.length - 40) + ' 件');
      lines.push('| ' + k + ' | ' + (v.length ? '落 ' + v.length : '通') + ' |');
    }
    console.log('\n' + (ctx.scan || ctx.repos).length + ' のリポジトリ、' + n.ファイル + ' のファイル、写し ' + n.写し + '、リンク ' + n.リンク + ' を見ました。');
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## 共通の検査', '', '| 見たもの | 結果 |', '| --- | --- |'].concat(lines).join('\n') + '\n\n');
    }
    if (Object.values(bad).some((v) => v.length)) process.exit(1);
  } catch (e) {
    console.error(e.hub ? e.message : e.stack);
    process.exit(1);
  }
}

module.exports = { check, context, linksOf, mailRules, conjugation, MAIL };
