/* リポジトリの CI のワークフローから、変更のたびに回る仕事を読み、repos.json と同じ形に直す。
 *
 * 読むのは、push か pull_request で起きるワークフローの、すべての仕事である。
 * 仕事ごとに、repos.json の jobs の一つと同じ形（runner・python・node・fetch-depth・workdir・steps）を作る。
 * 一つの値だけを並べる matrix は、値ごとの仕事に開く（${{ matrix.鍵 }} をその値に替える）。
 * 形に直せない仕事は、直せない理由（kind）を返す。repos.json は、その仕事を not_carried に置く。 */

'use strict';

const { parse } = require('./yaml.js');

const CHECKOUT = /^actions\/checkout@[0-9a-f]{40}$/;
const PYTHON = /^actions\/setup-python@[0-9a-f]{40}$/;
const NODE = /^actions\/setup-node@[0-9a-f]{40}$/;

/* 起きる出来事。on は文字列・並び・対応のどれでも書ける。 */
function triggers(wf) {
  const on = wf.on !== undefined ? wf.on : wf.true;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((k) => [k, null]));
  return on || {};
}

/* push か pull_request で起き、そのどちらかに paths の絞りが無ければ、変更のたびに回る。 */
function everyChange(wf) {
  const t = triggers(wf);
  const ev = ['push', 'pull_request'].filter((k) => k in t);
  if (!ev.length) return null;
  const filtered = ev.every((k) => t[k] && (t[k].paths || t[k]['paths-ignore']));
  return { events: ev, filtered };
}

function expand(job) {
  const m = job.strategy && job.strategy.matrix;
  if (!m) return [[null, job]];
  const keys = Object.keys(m);
  if (keys.length !== 1 || !Array.isArray(m[keys[0]]) || m[keys[0]].some((v) => typeof v !== 'string')) return null;
  const k = keys[0];
  return m[k].map((v) => {
    const rep = (x) => {
      if (typeof x === 'string') return x.split('${{ matrix.' + k + ' }}').join(v);
      if (Array.isArray(x)) return x.map(rep);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([a, b]) => [a, rep(b)]));
      return x;
    };
    return [k + '=' + v, rep(Object.assign({}, job, { strategy: undefined }))];
  });
}

/* 一つの仕事を、repos.json の形に直す。直せなければ { kind, why }。 */
function shape(job) {
  const no = (kind, why) => ({ kind, why });
  if (job.uses) return no('call', 'ほかのワークフローを呼ぶ仕事');
  if (job.if) return no('condition', '仕事に if がある');
  if (job.services || job.container) return no('container', '入れ物かサービスを使う');
  if (job.permissions && Object.values(job.permissions).some((v) => v === 'write')) return no('write', '書く権限を持つ');
  const out = { runner: job['runs-on'], python: null, node: null, 'fetch-depth': '1', workdir: null, steps: [] };
  if (typeof out.runner !== 'string') return no('runner', 'runs-on が一つの文字列でない');
  const d = job.defaults && job.defaults.run;
  if (d) {
    if (Object.keys(d).some((k) => k !== 'working-directory')) return no('defaults', 'defaults.run に working-directory のほかがある');
    out.workdir = d['working-directory'];
  }
  if (job.env) return no('env', '仕事の env がある');
  let main = false;
  for (const s of job.steps || []) {
    if (s.if || s['continue-on-error'] || s.shell || s.id) return no('step', '手順に if・continue-on-error・shell・id がある');
    if (s.uses) {
      const w = s.with || {};
      if (CHECKOUT.test(s.uses)) {
        if (w['persist-credentials'] !== 'false') return no('credentials', 'checkout が鍵を残す');
        const extra = Object.keys(w).filter((k) => !['persist-credentials', 'fetch-depth', 'repository', 'ref', 'path'].includes(k));
        if (extra.length) return no('checkout', 'checkout の ' + extra.join('・'));
        if (!w.repository) {
          if (main || w.ref || w.path) return no('checkout', '自分の checkout が二つ目か、ref か path を持つ');
          main = true;
          out['fetch-depth'] = w['fetch-depth'] === undefined ? '1' : w['fetch-depth'];
          continue;
        }
        if (!w.path || /\$\{\{/.test(w.repository + (w.ref || '') + w.path)) return no('checkout', '隣の checkout が path を持たないか、式を使う');
        const sib = { sibling: w.repository, path: w.path };
        if (w.ref) sib.ref = w.ref;
        if (w['fetch-depth'] !== undefined) return no('checkout', '隣の checkout の fetch-depth');
        out.steps.push(sib);
        continue;
      }
      if (PYTHON.test(s.uses) && Object.keys(w).join() === 'python-version' && out.python === null) { out.python = w['python-version']; continue; }
      if (NODE.test(s.uses) && Object.keys(w).join() === 'node-version' && out.node === null) { out.node = w['node-version']; continue; }
      if (s.uses.startsWith('./')) return no('action', 'このリポジトリの Action を使う（uses: ./）');
      return no('uses', 'ほかのアクション ' + s.uses.split('@')[0]);
    }
    if (typeof s.run !== 'string') return no('step', 'run も uses も無い手順');
    const st = { run: s.run.replace(/\n$/, '') };
    if (s.env) st.env = s.env;
    if (s['working-directory']) return no('step', '手順の working-directory');
    out.steps.push(st);
  }
  if (!main) return no('checkout', '自分を checkout しない');
  const text = JSON.stringify(out);
  if (/\$\{\{/.test(text)) return no('expression', '式（${{ }}）が残る');
  if (/\bGITHUB_TOKEN\b|\bACTIONS_RUNTIME_TOKEN\b/.test(text)) return no('token', '鍵を使う');
  return out;
}

/* files: { 'verify.yml': 本文 }。返り値: { id: { shape, events, filtered, file, job } }。id は「ファイル/仕事」か「ファイル/仕事/鍵=値」。 */
function jobsOf(files) {
  const out = {};
  for (const [file, text] of Object.entries(files).sort()) {
    let wf;
    try { wf = parse(text); } catch (e) { out[file] = { shape: { kind: 'yaml', why: e.message }, file }; continue; }
    const ev = everyChange(wf || {});
    if (!ev) continue;
    for (const [name, job] of Object.entries((wf && wf.jobs) || {})) {
      const parts = expand(job);
      if (parts === null) { out[file + '/' + name] = { shape: { kind: 'matrix', why: '一つの値の並びでない matrix' }, events: ev.events, filtered: ev.filtered, file, job: name }; continue; }
      for (const [m, j] of parts) {
        out[file + '/' + name + (m ? '/' + m : '')] = { shape: shape(j), events: ev.events, filtered: ev.filtered, file, job: name, def: j };
      }
    }
  }
  return out;
}

module.exports = { jobsOf, shape, triggers, everyChange };
