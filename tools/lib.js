/* 共通の検査の道具が使う、目録（repos.json）の読み方と確かめ方。
 *
 * 道具は二つの置き方で動く。
 *   ハブ：このリポジトリの tools/ にあり、一つ上の repos.json を読む。
 *   写し：呼ぶ側のリポジトリの .github/shared-check/ に一字一句同じ写しがあり、同じ場所の repo.json（そのリポジトリの欄だけ）を読む。
 * 道具には、どのリポジトリの名も書かない。名は目録にだけある。 */

'use strict';

const fs = require('fs');
const path = require('path');

const RUNNERS = ['ubuntu-latest', 'ubuntu-24.04'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(msg) {
  const e = new Error(msg);
  e.hub = true;
  throw e;
}

/* 相対の道。絶対の道も、上へ出る道も認めない（ハブの siblings だけは ../ で始まる一段を認める）。 */
function safePath(p, allowUp) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || /\\|\0/.test(p)) return false;
  const parts = p.split('/');
  return parts.every((x, k) => x !== '' && x !== '.' && (x !== '..' || (allowUp && k === 0)));
}

/* 仕事の欄を確かめる。おかしければ投げる。 */
function checkJob(job, where) {
  const at = where + ' の仕事 ' + (job && job.id);
  if (!job || typeof job.id !== 'string' || !/^[\w.\/=-]+$/.test(job.id)) fail(where + '：仕事の id');
  if (!RUNNERS.includes(job.runner)) fail(at + '：runner ' + job.runner);
  if (job.python !== null && !/^3\.\d{1,2}$/.test(job.python)) fail(at + '：python ' + job.python);
  if (job.node !== null && !/^\d{2}$/.test(job.node)) fail(at + '：node ' + job.node);
  if (!['0', '1'].includes(job['fetch-depth'])) fail(at + '：fetch-depth ' + job['fetch-depth']);
  if (job.workdir !== null && !safePath(job.workdir, false)) fail(at + '：workdir');
  if (!Array.isArray(job.steps) || job.steps.length === 0) fail(at + '：手順が無い');
  const keys = ['id', 'runner', 'python', 'node', 'fetch-depth', 'workdir', 'steps'];
  if (Object.keys(job).sort().join() !== keys.slice().sort().join()) fail(at + '：鍵の並び ' + Object.keys(job).join(','));
  for (const s of job.steps) {
    const k = Object.keys(s).sort().join();
    if (typeof s.run === 'string') {
      if (k !== 'run' && k !== 'env,run') fail(at + '：run の手順の鍵 ' + k);
      if (s.env && Object.entries(s.env).some(([a, b]) => !/^[A-Z][A-Z0-9_]*$/.test(a) || typeof b !== 'string')) fail(at + '：env');
    } else if (typeof s.sibling === 'string') {
      if (k !== 'path,sibling' && k !== 'path,ref,sibling') fail(at + '：隣の手順の鍵 ' + k);
      if (!FULL.test(s.sibling) || !safePath(s.path, false) || (s.ref !== undefined && !/^[0-9a-f]{40}$/.test(s.ref))) fail(at + '：隣の手順');
    } else if (typeof s.siblings === 'string') {
      if (k !== 'siblings' || !safePath(s.siblings, true)) fail(at + '：兄弟の手順');
    } else fail(at + '：知らない手順 ' + k);
  }
  if (/\$\{\{/.test(JSON.stringify(job))) fail(at + '：式（${{ }}）を持つ');
}

/* 道具の置き場から、目録を読む。 */
function load(toolsDir) {
  const hubFile = path.join(toolsDir, '..', 'repos.json');
  const selfFile = path.join(toolsDir, 'repo.json');
  if (fs.existsSync(hubFile) && path.basename(toolsDir) === 'tools') {
    const m = JSON.parse(fs.readFileSync(hubFile, 'utf8'));
    return { mode: 'hub', manifest: m, file: hubFile };
  }
  if (fs.existsSync(selfFile)) {
    const e = JSON.parse(fs.readFileSync(selfFile, 'utf8'));
    return { mode: 'self-contained', entry: e, file: selfFile };
  }
  return fail('目録が無い（' + hubFile + ' も ' + selfFile + ' も無い）');
}

/* 呼んだリポジトリ。GITHUB_REPOSITORY（持ち主/名）から取る。 */
function caller() {
  const full = process.env.GITHUB_REPOSITORY || '';
  if (!FULL.test(full)) fail('GITHUB_REPOSITORY が読めない');
  const [owner, name] = full.split('/');
  return { owner, name, full };
}

/* 呼んだリポジトリの欄。ハブの置き方では、目録に名があり、ハブを呼ぶ欄でなければならない。 */
function entryFor(loaded, name) {
  if (loaded.mode === 'self-contained') {
    if (loaded.entry.caller !== 'self-contained') fail('写しの目録が、写しで動く欄でない');
    return loaded.entry;
  }
  const m = loaded.manifest;
  const e = m.repos && Object.prototype.hasOwnProperty.call(m.repos, name) ? m.repos[name] : null;
  if (!e) fail('目録に ' + name + ' の欄が無い');
  if (e.caller === 'self-contained') fail(name + ' は、ハブを呼ばず写しで動くと目録にある');
  if (!['hub', 'self'].includes(e.caller)) fail(name + ' の caller が ' + e.caller);
  return e;
}

/* GitHub Actions の出力に一行足す。 */
function output(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  const v = String(value);
  if (/\n/.test(v)) fail('出力が二行にわたる');
  if (f) fs.appendFileSync(f, key + '=' + v + '\n');
  else console.log(key + '=' + v);
}

module.exports = { load, caller, entryFor, checkJob, output, fail, safePath, NAME, FULL, RUNNERS };
