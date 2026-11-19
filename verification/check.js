/* このリポジトリの検査。
 *
 *     node verification/check.js                    # 守り・目録の形・雛形・道具の振る舞い・散文
 *     node verification/check.js --repos <置き場>     # 加えて、目録と各リポジトリの CI・正本の写し・各リポジトリに置いた呼び出し
 *     node verification/check.js --break            # 検査を一つずつ壊し、どれも落ちることを確かめる（--repos と一緒にも使える）
 *
 * <置き場> には、目録のリポジトリが名ごとに並んでいる（<置き場>/<名>）。CI では、own の仕事が並べてから回す。
 * 検査は、読んだファイルの文（state）だけから判定する。壊すときは、state の文を書き換えて、同じ判定に渡す。
 * 壊し方の無い検査があれば、--break が落ちる。 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const Module = require('module');
const { parse } = require('./yaml.js');
const ci = require('./ci.js');

const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);
const BREAK = ARGV.includes('--break');
const REPOS = ARGV.includes('--repos') ? path.resolve(ARGV[ARGV.indexOf('--repos') + 1] || '') : null;

const SHARED = '.github/workflows/shared-check.yml';
const SELFTEST = '.github/workflows/self-test.yml';
const TEMPLATE = 'templates/hub.yml';
const LOCAL = 'templates/self-contained/shared.yml';
const CALLERS = [SELFTEST, TEMPLATE, LOCAL];
const FLOWS = [SHARED].concat(CALLERS);
const TOOLS = ['tools/lib.js', 'tools/plan.js', 'tools/own.js', 'tools/siblings.js', 'tools/common.js'];
const COPIES_JSON = 'verification/copies.json';
const MAX_MINUTES = 60;
const EVENT_REF = '${{ github.event.pull_request.head.sha || github.sha }}';
const GROUP = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" };
/* 決めごと 16〜18 の文（cpsbvbng26-dotcom の枝 claude/rule18-ten-1119、コミット 1065e7f の CLAUDE.md）の SHA-256。 */
const RULES_16_18 = 'f2abdefb941312298a1081e1b4f7fefa6a337204144d029de170c56d7cb7d9ac';

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const code = (t) => String(t || '').split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------- 読む ---------- */

function listHub() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile()).sort();
}

function readRepo(dir) {
  const files = {};
  const take = (rel) => { const p = path.join(dir, rel); if (fs.existsSync(p) && fs.statSync(p).isFile()) files[rel] = fs.readFileSync(p, 'utf8'); };
  const wd = path.join(dir, '.github', 'workflows');
  if (fs.existsSync(wd)) for (const f of fs.readdirSync(wd)) if (/\.ya?ml$/.test(f)) take('.github/workflows/' + f);
  const sc = path.join(dir, '.github', 'shared-check');
  if (fs.existsSync(sc)) for (const f of fs.readdirSync(sc)) take('.github/shared-check/' + f);
  for (const f of ['SECURITY.md', '.github/ISSUE_TEMPLATE/error-report.yml', '.github/checked-intake/verify.js', 'CLAUDE.md']) take(f);
  return files;
}

function load() {
  const text = {};
  for (const f of listHub()) text[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  let repos = null;
  if (REPOS) {
    repos = {};
    for (const d of fs.existsSync(REPOS) ? fs.readdirSync(REPOS) : []) if (fs.existsSync(path.join(REPOS, d, '.git'))) repos[d] = readRepo(path.join(REPOS, d));
  }
  return { text, repos };
}

const yamlCache = new Map();
function Y(t) {
  if (!yamlCache.has(t)) { let v; try { v = parse(t) || {}; } catch (e) { v = { __error: e.message }; } yamlCache.set(t, v); }
  return yamlCache.get(t);
}
function J(t) { try { return JSON.parse(t); } catch (e) { return null; } }
const manifestOf = (s) => J(s.text['repos.json']) || { repos: {}, common: {} };

/* git の答え。雛形の値のコミットが履歴にあり、HEAD の祖先で、ワークフロー・道具・目録がいまと同じか。 */
const gitCache = new Map();
function pinFacts(sha) {
  if (gitCache.has(sha)) return gitCache.get(sha);
  const g = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  const exists = /^[0-9a-f]{40}$/.test(sha) && g(['cat-file', '-e', sha + '^{commit}']).status === 0;
  const ancestor = exists && g(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
  const sameFiles = exists && g(['diff', '--quiet', sha, '--', SHARED, 'tools', 'repos.json']).status === 0;
  const r = { exists, ancestor, sameFiles };
  gitCache.set(sha, r);
  return r;
}

/* ---------- ワークフローの歩き方 ---------- */

const jobsOf = (w) => Object.entries((w && w.jobs) || {});
const stepsOf = (w) => jobsOf(w).flatMap(([id, j]) => (j.steps || []).map((s) => [id, s]));
const usesLine = (t, u) => (String(t).split('\n').find((l) => l.includes('uses: ' + u)) || '');

/* ---------- 検査 ---------- */

const CHECKS = [];
const NOTES = new Set();
const check = (name, fn, needsRepos) => CHECKS.push({ name, fn, needsRepos: !!needsRepos });

check('YAML として読める', (s) => {
  const bad = [];
  /* 正本の写しはここで直さないので、読めなくても落とさずに書き出す（直すのは正本の側）。 */
  for (const f of Object.keys(s.text).filter((x) => /\.ya?ml$/.test(x))) {
    const w = Y(s.text[f]);
    if (!w.__error) continue;
    if (copiesOf(s).includes(f)) NOTES.add(f + '（正本の写し）：' + w.__error);
    else bad.push(f + '：' + w.__error);
  }
  return bad;
});

check('ワークフローの権限', (s) => {
  const bad = [];
  for (const f of FLOWS) {
    const w = Y(s.text[f] || '');
    if (w.__error) { bad.push(f + '：' + w.__error); continue; }
    if (!same(w.permissions, { contents: 'read' })) bad.push(f + '：全体の権限が contents: read だけでない');
    for (const [id, j] of jobsOf(w)) if (j.permissions !== undefined) bad.push(f + ' ' + id + '：仕事ごとの権限がある');
    if (/\bwrite\b|write-all|read-all/.test(code(s.text[f]))) bad.push(f + '：write の語がある');
  }
  return bad;
});

check('鍵を読まない', (s) => {
  const bad = [];
  for (const f of FLOWS) {
    const c = code(s.text[f]);
    if (/\bsecrets\b|github\.token|GITHUB_TOKEN/.test(c)) bad.push(f + '：鍵の語がある');
  }
  const w = Y(s.text[SHARED] || '');
  const call = w.on && w.on.workflow_call;
  if (call !== null) bad.push(SHARED + '：workflow_call が入力か鍵を受け取る');
  for (const f of TOOLS) if (/GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|authorization|process\.env\.[A-Z_]*TOKEN/i.test(s.text[f] || '')) bad.push(f + '：鍵の語がある');
  return bad;
});

check('アクションを固める', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const intake = s.text['.github/workflows/checked-intake.yml'] || '';
  const pins = {};
  for (const f of [SHARED]) {
    for (const [id, st] of stepsOf(Y(s.text[f] || ''))) {
      if (!st.uses) continue;
      const mm = /^(actions\/(checkout|setup-node|setup-python))@([0-9a-f]{40})$/.exec(st.uses);
      if (!mm) { bad.push(f + ' ' + id + '：固めていない ' + st.uses); continue; }
      const line = usesLine(s.text[f], st.uses);
      const ver = (/ # (v\d+(?:\.\d+)*)\s*$/.exec(line) || [])[1];
      if (!ver) bad.push(f + ' ' + id + '：版の注釈が無い ' + mm[1]);
      const k = mm[1];
      if (pins[k] && pins[k] !== st.uses + ' ' + ver) bad.push(f + '：' + k + ' の値か注釈が揃わない');
      pins[k] = st.uses + ' ' + ver;
      if (k !== 'actions/setup-python' && !intake.includes('uses: ' + st.uses + ' # ' + ver)) bad.push(f + '：' + k + ' が、受付（checked-intake.yml）と同じ値と注釈でない');
    }
  }
  for (const f of [SELFTEST, LOCAL]) {
    const js = jobsOf(Y(s.text[f] || ''));
    if (js.length !== 1 || js[0][1].uses !== './.github/workflows/shared-check.yml') bad.push(f + '：同じリポジトリの shared-check.yml を呼ばない');
  }
  const t = Y(s.text[TEMPLATE] || '');
  const js = jobsOf(t);
  const want = new RegExp('^' + m.owner + '/' + m.hub + '/\\.github/workflows/shared-check\\.yml@[0-9a-f]{40}$');
  if (js.length !== 1 || !want.test(js[0][1].uses || '')) bad.push(TEMPLATE + '：ハブのワークフローをコミットの値で呼ばない');
  else if (!new RegExp(' # ' + m.version + '\\s*$').test(usesLine(s.text[TEMPLATE], js[0][1].uses))) bad.push(TEMPLATE + '：版の注釈が目録の version（' + m.version + '）でない');
  for (const f of FLOWS) for (const [, st] of stepsOf(Y(s.text[f] || ''))) if (st.uses && st.uses.startsWith('./')) bad.push(f + '：手順に uses: ./');
  return bad;
});

check('時間の上限', (s) => {
  const bad = [];
  const w = Y(s.text[SHARED] || '');
  if (!jobsOf(w).length) bad.push(SHARED + '：仕事が無い');
  for (const [id, j] of jobsOf(w)) {
    const t = j['timeout-minutes'];
    if (!/^\d+$/.test(t || '') || Number(t) < 1 || Number(t) > MAX_MINUTES) bad.push(SHARED + ' ' + id + '：時間の上限 ' + t);
  }
  for (const f of CALLERS) for (const [id, j] of jobsOf(Y(s.text[f] || ''))) if (!j.uses) bad.push(f + ' ' + id + '：呼ぶ仕事でない（時間の上限は呼ばれる側に置く）');
  return bad;
});

check('run の行に式を書かない', (s) => {
  const bad = [];
  for (const f of FLOWS) {
    for (const [id, st] of stepsOf(Y(s.text[f] || ''))) {
      if (typeof st.run === 'string' && /\$\{\{/.test(st.run)) bad.push(f + ' ' + id + '：run の行に式');
    }
    const ev = [...code(s.text[f]).matchAll(/github\.event\.[A-Za-z_.]+/g)].map((x) => x[0]);
    for (const e of ev) if (e !== 'github.event.pull_request.head.sha') bad.push(f + '：出来事の値 ' + e);
    for (const [id, st] of stepsOf(Y(s.text[f] || ''))) {
      const vals = JSON.stringify(Object.assign({}, st, { with: undefined }));
      if (/github\.event\./.test(vals)) bad.push(f + ' ' + id + '：出来事の値を checkout の ref の外で読む');
      for (const [k, v] of Object.entries(st.with || {})) if (/github\.event\./.test(v) && !(k === 'ref' && v === EVENT_REF && /^actions\/checkout@/.test(st.uses || ''))) bad.push(f + ' ' + id + '：出来事の値を ' + k + ' で読む');
    }
  }
  return bad;
});

check('同時実行の組', (s) => {
  const bad = [];
  const w = Y(s.text[SHARED] || '');
  if (w.concurrency !== undefined) bad.push(SHARED + '：全体に組がある');
  for (const [id, j] of jobsOf(w)) if (j.concurrency !== undefined) bad.push(SHARED + ' ' + id + '：仕事に組がある（matrix の仕事どうしが取り消し合う）');
  for (const f of CALLERS) {
    const c = Y(s.text[f] || '');
    if (c.concurrency !== undefined) bad.push(f + '：全体に組がある');
    const js = jobsOf(c);
    if (js.length !== 1 || !same(js[0][1].concurrency, GROUP)) bad.push(f + '：呼ぶ仕事の組が決めた形でない');
  }
  return bad;
});

check('起こす出来事', (s) => {
  const bad = [];
  const w = Y(s.text[SHARED] || '');
  if (!same(w.on, { workflow_call: null })) bad.push(SHARED + '：起こすのが workflow_call だけでない');
  for (const f of CALLERS) {
    const on = Y(s.text[f] || '').on || {};
    const keys = Object.keys(on);
    if (keys.some((k) => !['push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(k))) bad.push(f + '：起こす出来事 ' + keys.join(','));
    if (!same(on.push, { branches: ['main'] }) || on.pull_request !== null) bad.push(f + '：main への push と、絞りの無い PR で起きない');
  }
  for (const f of FLOWS) if (/pull_request_target|workflow_run/.test(code(s.text[f]))) bad.push(f + '：pull_request_target か workflow_run がある');
  return bad;
});

check('checkout が鍵を残さない', (s) => {
  const bad = [];
  let n = 0;
  for (const f of FLOWS) for (const [id, st] of stepsOf(Y(s.text[f] || ''))) {
    if (!/^actions\/checkout@/.test(st.uses || '')) continue;
    n++;
    if (!st.with || st.with['persist-credentials'] !== 'false') bad.push(f + ' ' + id + '：checkout が鍵を残す');
  }
  if (n === 0) bad.push('checkout が一つも無い');
  return bad;
});

check('道具を同じコミットから読む', (s) => {
  const bad = [];
  const w = Y(s.text[SHARED] || '');
  for (const [id, j] of jobsOf(w)) {
    const st = j.steps || [];
    const first = st[0] || {};
    const env = first.env || {};
    if (env.SOURCE_REPOSITORY !== '${{ job.workflow_repository }}' || env.SOURCE_SHA !== '${{ job.workflow_sha }}'
      || !/\[\[ "\$SOURCE_REPOSITORY" =~ \^\[A-Za-z0-9-\]\+\/\[A-Za-z0-9\._-\]\+\$ \]\] \|\| \{[^}]*exit 1; \}/.test(first.run || '')
      || !/\[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| \{[^}]*exit 1; \}/.test(first.run || '')) bad.push(id + '：最初の手順が、置き場とコミットの値を確かめない');
    const outs = st.filter((x) => /^actions\/checkout@/.test(x.uses || '') && x.with && x.with.repository);
    if (outs.length !== 1 || outs[0].with.repository !== '${{ job.workflow_repository }}' || outs[0].with.ref !== '${{ job.workflow_sha }}') bad.push(id + '：道具を、このワークフローの置き場とコミットから取り出さない');
    const mine = st.filter((x) => /^actions\/checkout@/.test(x.uses || '') && x.with && !x.with.repository);
    if (id !== 'plan' && (mine.length !== 1 || mine[0].with.ref !== EVENT_REF)) bad.push(id + '：呼んだリポジトリを PR の先のコミットで取り出さない');
    if (id === 'plan' && mine.length) bad.push('plan：呼んだリポジトリを取り出す');
  }
  const own = (w.jobs || {}).own || {};
  const runs = (own.steps || []).map((x) => x.run || '').join('\n');
  if (!/mv \.shared-check-source "\$RUNNER_TEMP\/shared-check-source"/.test(runs)) bad.push('own：道具を、検査するリポジトリの外へ移さない');
  return bad;
});

check('リポジトリの名を書かない', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const names = Object.keys(m.repos || {}).concat([m.owner, m.hub]).filter(Boolean);
  if (names.length < 3) bad.push('目録の名が読めない');
  for (const f of [SHARED, LOCAL].concat(TOOLS)) {
    const t = String(s.text[f] || '').toLowerCase();
    for (const n of names) if (t.includes(n.toLowerCase())) bad.push(f + '：' + n);
  }
  return bad;
});

const KINDS = ['condition', 'write', 'uses', 'action', 'expression', 'checkout', 'token', 'call', 'credentials', 'step', 'env', 'defaults', 'runner', 'matrix', 'container', 'yaml', 'network', 'common'];
check('目録の形', (s) => {
  const bad = [];
  const m = J(s.text['repos.json']);
  if (!m) return ['repos.json が読めない'];
  let lib;
  try { lib = loadTool(s, 'tools/lib.js'); } catch (e) { return ['tools/lib.js が読めない'];
  }
  const top = ['_', 'version', 'owner', 'hub', 'entrance', 'common', 'repos'];
  if (!same(Object.keys(m), top)) bad.push('目録の鍵の並び');
  if (!/^v\d+$/.test(m.version || '')) bad.push('version');
  const ck = ['from', 'python', 'node', 'requirements', 'steps', 'copies', 'mailRules', 'textRules'];
  if (!m.common || !same(Object.keys(m.common), ck)) bad.push('common の鍵の並び');
  const names = Object.keys(m.repos || {});
  if (!same(names, names.slice().sort())) bad.push('repos が名の順でない');
  if (!m.repos[m.hub] || m.repos[m.hub].caller !== 'self') bad.push('ハブ自身の欄が self でない');
  if (!m.repos[m.entrance] || m.repos[m.entrance].caller !== 'hub') bad.push('entrance の欄');
  if (names.filter((n) => m.repos[n].caller === 'self').length !== 1) bad.push('self の欄が一つでない');
  for (const n of names) {
    const e = m.repos[n];
    if (!lib.NAME.test(n)) bad.push(n + '：名の形');
    if (!['hub', 'self', 'self-contained'].includes(e.caller)) bad.push(n + '：caller ' + e.caller);
    const keys = Object.keys(e);
    if (keys.some((k) => !['caller', 'copies', 'mail', 'jobs', 'not_carried'].includes(k)) || !['caller', 'copies', 'jobs', 'not_carried'].every((k) => keys.includes(k))) bad.push(n + '：欄の鍵');
    if (!Array.isArray(e.copies) || e.copies.some((c) => !(m.common.copies || []).includes(c))) bad.push(n + '：copies が common.copies の外');
    if (e.mail && (!e.mail.why || !Array.isArray(e.mail.allowed) || !e.mail.allowed.length || e.mail.allowed.some((h) => !/^[0-9a-f]{64}$/.test(h)))) bad.push(n + '：mail');
    const ids = new Set();
    for (const j of e.jobs || []) {
      try { lib.checkJob(j, n); } catch (x) { bad.push(x.message); }
      if (ids.has(j.id)) bad.push(n + '：同じ id ' + j.id);
      ids.add(j.id);
      if (e.caller !== 'self' && j.steps && j.steps.some((x) => x.siblings !== undefined)) bad.push(n + '：兄弟をすべて取る手順');
    }
    if (!(e.jobs || []).length) bad.push(n + '：検査の仕事が無い');
    for (const [id, v] of Object.entries(e.not_carried || {})) {
      if (!v || !KINDS.includes(v.kind) || typeof v.why !== 'string' || v.why.length < 8) bad.push(n + '：not_carried ' + id);
      if (ids.has(id)) bad.push(n + '：' + id + ' が jobs と not_carried の両方にある');
    }
  }
  if (!lib.safePath(m.common.requirements || '', false) || !same(m.common.steps, ['node verification/check_all.js', 'node verification/check_ecosystem.js'])) bad.push('common の手順');
  return bad;
});

check('目録と各リポジトリの CI', (s) => {
  const bad = [];
  const m = manifestOf(s);
  for (const n of Object.keys(m.repos)) {
    if (n === m.hub) continue;
    const r = s.repos[n];
    if (!r) { bad.push(n + '：並べた置き場に無い'); continue; }
    const files = Object.fromEntries(Object.entries(r).filter(([f]) => f.startsWith('.github/workflows/')).map(([f, t]) => [f.slice('.github/workflows/'.length), t]));
    /* 呼び出しの写し（hub.yml・shared.yml・shared-check.yml）は CI の検査の手順ではないので、照らす前に外す。 */
    for (const f of ['hub.yml', 'shared.yml', 'shared-check.yml']) delete files[f];
    const got = ci.jobsOf(files);
    const e = m.repos[n];
    const listed = new Set((e.jobs || []).map((j) => j.id).concat(Object.keys(e.not_carried || {})));
    for (const id of Object.keys(got)) if (!listed.has(id)) bad.push(n + '：CI の ' + id + ' が目録に無い');
    for (const id of listed) if (!got[id]) bad.push(n + '：目録の ' + id + ' が CI に無い');
    for (const j of e.jobs || []) {
      const g = got[j.id];
      if (!g) continue;
      const want = Object.assign({}, j);
      delete want.id;
      if (g.shape.kind) bad.push(n + '：' + j.id + ' は写せない形（' + g.shape.kind + '）');
      else if (!same(g.shape, want)) bad.push(n + '：' + j.id + ' の手順が CI と違う');
    }
    for (const [id, v] of Object.entries(e.not_carried || {})) {
      const g = got[id];
      if (!g) continue;
      if (v.kind === 'network') { if (g.shape.kind) bad.push(n + '：' + id + ' は network と書くが、形の上でも写せない（' + g.shape.kind + '）'); }
      else if (v.kind === 'common') { if (n !== m.entrance || id !== m.common.from) bad.push(n + '：' + id + ' は common でない'); }
      else if (g.shape.kind !== v.kind) bad.push(n + '：' + id + ' の理由が ' + v.kind + ' だが、ワークフローからは ' + (g.shape.kind || '写せる形'));
    }
  }
  return bad;
}, true);

check('横断の手順と正本の CI', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const w = Y(s.text[SHARED] || '');
  const st = ((w.jobs || {}).common || {}).steps || [];
  const wd = st.filter((x) => x['working-directory'] === 'repos/${{ needs.plan.outputs.entrance }}').map((x) => x.run);
  if (!same(wd, m.common.steps)) bad.push(SHARED + '：common の仕事の横断の手順が、目録の common.steps と違う');
  if (!st.some((x) => (x.run || '').trim() === 'pip install --require-hashes --only-binary=:all: -r "$REQUIREMENTS"' && x.env && x.env.REQUIREMENTS === '${{ needs.plan.outputs.requirements }}')) bad.push(SHARED + '：pip が版とハッシュを固めた一覧から入れない');
  if (!st.some((x) => /^actions\/setup-python@/.test(x.uses || '') && x.with && x.with['python-version'] === m.common.python)) bad.push(SHARED + '：Python の版が目録と違う');
  for (const [id, x] of stepsOf(w)) if (/^actions\/setup-node@/.test(x.uses || '') && x.with['node-version'] !== m.common.node && x.with['node-version'] !== '${{ matrix.job.node }}') bad.push(SHARED + ' ' + id + '：Node の版が目録と違う');
  if (s.repos) {
    const eco = (s.repos[m.entrance] || {})['.github/workflows/' + m.common.from.split('/')[0]];
    const j = eco ? ((Y(eco).jobs || {})[m.common.from.split('/')[1]] || null) : null;
    if (!j) bad.push(m.entrance + '：' + m.common.from + ' が無い');
    else {
      const runs = (j.steps || []).filter((x) => x['working-directory']).map((x) => x.run);
      if (!same(runs, m.common.steps)) bad.push(m.entrance + '：' + m.common.from + ' の手順が目録の common.steps と違う');
      const pip = (j.steps || []).map((x) => x.run || '').join('\n');
      if (!pip.includes('-r repos/' + m.entrance + '/' + m.common.requirements)) bad.push(m.entrance + '：pip の一覧が目録の requirements と違う');
      if (!(j.steps || []).some((x) => /^actions\/setup-python@/.test(x.uses || '') && x.with['python-version'] === m.common.python)) bad.push(m.entrance + '：Python の版が目録と違う');
    }
  }
  return bad;
});

check('正本の写し', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const cj = J(s.text[COPIES_JSON]) || {};
  const list = Object.keys(cj['写し'] || {});
  if (!same(list.slice().sort(), (m.common.copies || []).slice().sort()) || !same((m.repos[m.hub] || {}).copies, m.common.copies)) bad.push('copies.json・目録の common.copies・ハブ自身の copies が揃わない');
  for (const f of list) {
    if (s.text[f] === undefined) { bad.push(f + '：写しが無い'); continue; }
    if (sha256(Buffer.from(s.text[f], 'utf8')) !== cj['写し'][f]) bad.push(f + '：copies.json の SHA-256 と違う');
    if (s.repos) {
      const e = (s.repos[m.entrance] || {})[f];
      if (e === undefined) bad.push(f + '：正本が読めない');
      else if (e !== s.text[f]) bad.push(f + '：並べた正本と違う');
    }
  }
  return bad;
});

check('呼ぶ側の雛形', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const t = Y(s.text[TEMPLATE] || '');
  const st = Y(s.text[SELFTEST] || '');
  const lc = Y(s.text[LOCAL] || '');
  const sha = (/@([0-9a-f]{40})$/.exec(((t.jobs || {}).shared || {}).uses || '') || [])[1];
  if (!sha) return [TEMPLATE + '：コミットの値が読めない'];
  const p = pinFacts(sha);
  if (!p.exists) bad.push(TEMPLATE + '：' + sha.slice(0, 7) + ' がこのリポジトリの履歴に無い');
  else if (!p.ancestor) bad.push(TEMPLATE + '：' + sha.slice(0, 7) + ' がいまのコミットの祖先でない');
  else if (!p.sameFiles) bad.push(TEMPLATE + '：' + sha.slice(0, 7) + ' のワークフロー・道具・目録が、いまのものと違う（雛形の値を上げる）');
  const strip = (x) => { const y = clone(x); if (y.jobs && y.jobs.shared) delete y.jobs.shared.uses; if (y.on) delete y.on.schedule; return y; };
  if (!same(strip(t), strip(st)) || !same(strip(t), strip(lc))) bad.push('雛形・自分を確かめる呼び出し・写しの呼び出しが、呼ぶ先と定期のほかで揃わない');
  if (!st.on || !st.on.schedule || (t.on && t.on.schedule) || (lc.on && lc.on.schedule)) bad.push('定期に回すのは、自分を確かめる呼び出しだけ');
  void m;
  return bad;
});

check('各リポジトリに置いた呼び出し', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const tline = (x) => String(x || '').replace(/(shared-check\.yml@)[0-9a-f]{40}/, '$1<sha>');
  for (const n of Object.keys(m.repos)) {
    if (n === m.hub) continue;
    const r = s.repos[n] || {};
    const e = m.repos[n];
    if (e.caller === 'hub') {
      const h = r['.github/workflows/hub.yml'];
      if (h !== undefined) {
        if (tline(h) !== tline(s.text[TEMPLATE])) bad.push(n + '：hub.yml が雛形と、コミットの値のほかで違う');
        const sha = (/shared-check\.yml@([0-9a-f]{40})/.exec(h) || [])[1];
        if (!sha || !pinFacts(sha).exists) bad.push(n + '：hub.yml の値がハブの履歴に無い');
      }
      for (const f of Object.keys(r)) if (f.startsWith('.github/shared-check/') || f === '.github/workflows/shared-check.yml') bad.push(n + '：ハブを呼ぶリポジトリに写しがある ' + f);
    } else if (e.caller === 'self-contained') {
      if (r['.github/workflows/hub.yml'] !== undefined) bad.push(n + '：写しで動くリポジトリが hub.yml を持つ');
      const has = Object.keys(r).some((f) => f.startsWith('.github/shared-check/') || f === '.github/workflows/shared-check.yml' || f === '.github/workflows/shared.yml');
      if (!has) continue;
      if (r['.github/workflows/shared-check.yml'] !== s.text[SHARED]) bad.push(n + '：shared-check.yml の写しが違う');
      if (r['.github/workflows/shared.yml'] !== s.text[LOCAL]) bad.push(n + '：shared.yml が写しの呼び出しと違う');
      for (const f of TOOLS) if (r['.github/shared-check/' + path.basename(f)] !== s.text[f]) bad.push(n + '：' + path.basename(f) + ' の写しが違う');
      if (!same(J(r['.github/shared-check/repo.json'] || ''), e)) bad.push(n + '：repo.json が目録の欄と違う');
      const extra = Object.keys(r).filter((f) => f.startsWith('.github/shared-check/') && !TOOLS.map((x) => '.github/shared-check/' + path.basename(x)).concat(['.github/shared-check/repo.json']).includes(f));
      if (extra.length) bad.push(n + '：写しの置き場に余りのファイル ' + extra.join(','));
    }
  }
  return bad;
}, true);

/* ---------- 道具の振る舞い ---------- */

/* 道具を、state の文から読み込む（壊した文は、壊したまま動く）。tools/ の中の require は state の文から解く。 */
function loadTool(s, rel, extraEnv) {
  const cache = {};
  const req = (from) => (spec) => {
    if (spec.startsWith('./')) {
      const target = path.posix.join(path.posix.dirname(from), spec);
      if (!cache[target]) {
        if (s.text[target] === undefined) throw new Error(target + ' が無い');
        const mod = { exports: {} };
        cache[target] = mod;
        const file = path.join(ROOT, target);
        new Function('module', 'exports', 'require', '__dirname', '__filename', s.text[target].replace(/^#!.*\n/, ''))(mod, mod.exports, req(target), path.dirname(file), file);
      }
      return cache[target].exports;
    }
    return Module.createRequire(path.join(ROOT, from))(spec);
  };
  void extraEnv;
  return req('x.js')('./' + rel);
}

function tmpdir() { return fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-check-')); }

check('道具の振る舞い', (s) => {
  const bad = [];
  let lib, plan, own, common;
  try { lib = loadTool(s, 'tools/lib.js'); plan = loadTool(s, 'tools/plan.js'); own = loadTool(s, 'tools/own.js'); common = loadTool(s, 'tools/common.js'); } catch (e) { return ['道具が読めない：' + e.message]; }
  const m = J(s.text['repos.json']);
  /* plan：ハブの置き方。どの欄も、目録の仕事の数だけ並べる。写しで動く欄は落ちる。 */
  for (const n of Object.keys(m.repos)) {
    const e = m.repos[n];
    let out = null, err = null;
    try { out = plan.plan({ mode: 'hub', manifest: m }, n); } catch (x) { err = x; }
    if (e.caller === 'self-contained') { if (!err) bad.push('plan：写しで動く ' + n + ' をハブの置き方で通す'); continue; }
    if (err || JSON.parse(out.jobs).length !== e.jobs.length || out.common !== 'true' || out.requirements !== 'repos/' + m.entrance + '/' + m.common.requirements) bad.push('plan：' + n);
  }
  try { plan.plan({ mode: 'hub', manifest: m }, 'no-such-repository'); bad.push('plan：目録に無いリポジトリを通す'); } catch (x) { /* 落ちてよい */ }
  /* plan：写しの置き方。 */
  const sc = Object.keys(m.repos).find((n) => m.repos[n].caller === 'self-contained');
  if (sc) {
    try {
      const out = plan.plan({ mode: 'self-contained', entry: m.repos[sc] }, sc);
      if (out.common !== 'false' || out.entrance !== '' || JSON.parse(out.jobs).length !== m.repos[sc].jobs.length) bad.push('plan：写しの置き方の値');
    } catch (x) { bad.push('plan：写しの置き方で落ちる ' + x.message); }
  }
  /* lib.load：置き方を、道具の置き場から決める。 */
  const d = tmpdir();
  try {
    fs.mkdirSync(path.join(d, 'hub', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(d, 'hub', 'repos.json'), s.text['repos.json']);
    fs.mkdirSync(path.join(d, 'copy', '.github', 'shared-check'), { recursive: true });
    if (sc) fs.writeFileSync(path.join(d, 'copy', '.github', 'shared-check', 'repo.json'), JSON.stringify(m.repos[sc]));
    if (lib.load(path.join(d, 'hub', 'tools')).mode !== 'hub') bad.push('lib.load：ハブの置き方を読まない');
    if (sc && lib.load(path.join(d, 'copy', '.github', 'shared-check')).mode !== 'self-contained') bad.push('lib.load：写しの置き方を読まない');
    let threw = false;
    try { lib.load(path.join(d, 'nowhere')); } catch (x) { threw = true; }
    if (!threw) bad.push('lib.load：目録が無いのに通す');
    /* own：手順を上から回し、落ちたところで止まる。env を渡す。隣の複製は写しの置き方では断る。 */
    const log = console.log;
    console.log = () => {};
    const cwd = process.cwd();
    try {
      process.chdir(d);
      const job = { id: 'x', runner: 'ubuntu-latest', python: null, node: null, 'fetch-depth': '1', workdir: null,
        steps: [{ run: 'echo "$HUB_T" > a.txt', env: { HUB_T: 'one' } }, { run: 'false' }, { run: 'echo two > b.txt' }] };
      const r = own.run(job, { clone: () => { throw new Error('x'); }, all: () => {} });
      if (r.ok || r.at !== 2 || fs.readFileSync('a.txt', 'utf8') !== 'one\n' || fs.existsSync('b.txt')) bad.push('own：落ちた手順で止まらないか、env を渡さない');
      const piped = own.run(Object.assign({}, job, { steps: [{ run: 'false | true' }] }), {});
      if (piped.ok) bad.push('own：pipefail が効かない');
    } finally { process.chdir(cwd); console.log = log; }
    /* common：作った二つのリポジトリで、宛先・壊れた活用・リンク・写しを見る。 */
    const root = path.join(d, 'root');
    const mk = (repo, files) => {
      const dir = path.join(root, repo);
      for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
    };
    const at = '@';
    const W = '書' + 'いました';
    mk('e', { 'verification/check_secrets.js': "const ALLOWED_MAIL = ['ok" + at + "example.com'];\nconst ALLOWED_MAIL_RE = /" + at + "users\\.noreply\\.github\\.com$/;\n",
      'verification/check_text.js': "const CONJUGATION = [\n  { re: /" + W + "/, right: 'x', note: '「書いた」＋「ました」' },\n];\n", 'S.md': 'same\n' });
    mk('a', { 'S.md': 'same\n', 'README.md': '[x](./docs/b.md) [y](./gone.md) <!-- [z](./hidden.md) -->\n```\n[w](./fenced.md)\n```\n[g](https://github.com/o/e/blob/main/S.md) [h](https://github.com/o/e/blob/main/nothing.md)\n',
      'docs/b.md': 'bad' + at + 'example.org ok' + at + 'example.com\nPn' + at + 'Pn.T-np.eye(n)\n' + W + '\n', 'c.ics': 'UID:1' + at + 'example.net\n' });
    const ctx = { owner: 'o', repos: ['a', 'e'], mail: common.mailRules(fs.readFileSync(path.join(root, 'e', 'verification/check_secrets.js'), 'utf8')),
      conj: common.conjugation(fs.readFileSync(path.join(root, 'e', 'verification/check_text.js'), 'utf8')), conjFile: ['e', 'verification/check_text.js'],
      skipMail: ['e/verification/check_secrets.js'], hashes: {}, copies: { entrance: 'e', paths: ['S.md'], listed: { a: ['S.md'], e: ['S.md'] } } };
    const res = common.check(root, ctx);
    const scan = res.bad.走査.join('\n'), links = res.bad.つながり.join('\n');
    if (!/a\/docs\/b\.md:1：許していない/.test(scan) || /b\.md:2/.test(scan) || /c\.ics/.test(scan) || res.bad.走査.filter((x) => /宛先|メール/.test(x)).length !== 1) bad.push('common：宛先の走査 ' + scan.replace(/\n/g, ' / '));
    if (!/a\/docs\/b\.md:3：壊れた活用/.test(scan)) bad.push('common：壊れた活用を拾わない');
    if (!/gone\.md/.test(links) || /hidden|fenced|b\.md/.test(links) || !/nothing\.md/.test(links) || res.bad.つながり.length !== 2) bad.push('common：つながり ' + links.replace(/\n/g, ' / '));
    if (res.bad.写し.length !== 0) bad.push('common：同じ写しを落とす');
    fs.writeFileSync(path.join(root, 'a', 'S.md'), 'other\n');
    if (common.check(root, ctx).bad.写し.length !== 1) bad.push('common：違う写しを通す');
  } catch (x) {
    bad.push('道具の振る舞いを確かめられない：' + x.message);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  return bad;
});

/* ---------- このリポジトリの文 ---------- */

const MAIL = new RegExp('[A-Za-z0-9._%+-]+' + '@' + '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}');
const copiesOf = (s) => Object.keys((J(s.text[COPIES_JSON]) || {})['写し'] || {});
const authored = (s) => Object.keys(s.text).filter((f) => !copiesOf(s).includes(f) && !/^LICENSE/.test(f));
const PROSE = (s) => Object.keys(s.text).filter((f) => /^(README\.md|docs\/[^/]+\.md)$/.test(f));

check('メールアドレス', (s) => Object.keys(s.text).filter((f) => MAIL.test(s.text[f])).map((f) => f + '：メールアドレスの形がある'));

/* 使わない語。書き写すとこのファイルが掛かるので、切って繋ぐ。 */
const NOT_SAY = ['ZEN' + '大学', 'ZEN ' + 'University', '大' + '学', 'Univer' + 'sity', '独立' + '研究者', 'Independent ' + 'Researcher'];
check('所属と学校の名・肩書き', (s) => authored(s).filter((f) => f !== 'verification/check.js').flatMap((f) => NOT_SAY.filter((w) => s.text[f].toLowerCase().includes(w.toLowerCase())).map((w) => f + '：使わない語（' + w.length + ' 字）')));

check('分けておくリポジトリの名', (s) => {
  const m = manifestOf(s);
  const names = Object.keys(m.repos || {}).filter((n) => m.repos[n].caller === 'self-contained');
  const kana = ['ヌス' + 'クァマ'];
  const bad = [];
  if (!names.length) bad.push('目録に self-contained の欄が無い');
  for (const f of Object.keys(s.text)) {
    const t = s.text[f].toLowerCase();
    for (const n of names.concat(kana)) {
      const k = t.split(n.toLowerCase()).length - 1;
      if (f === 'repos.json' && kana.indexOf(n) < 0 ? k !== 1 : k !== 0) bad.push(f + '：分けておくリポジトリの名が ' + k + ' か所');
    }
  }
  return bad;
});

const ORDERS = ['して' + 'ください', '利用者の' + '手作業', '利用者が' + '確かめる', 'needs the ' + 'owner', 'for the owner ' + 'to', 'the operator ' + 'merges', 'for the operator to ' + 'confirm', '運営者が' + '確かめ'];
check('利用者に仕事を作らない', (s) => authored(s).filter((f) => f !== 'CLAUDE.md' && f !== 'verification/check.js').flatMap((f) => ORDERS.filter((w) => s.text[f].includes(w)).map((w) => f + '：「' + w + '」')));

check('issue を読まない', (s) => {
  const bad = [];
  for (const f of authored(s).filter((x) => /^(tools|verification)\/.*\.js$/.test(x) && x !== 'verification/check.js')) {
    if (/api\.github\.com|\/issues\b/.test(s.text[f])) bad.push(f + '：GitHub の API か issue に触れる');
  }
  for (const f of FLOWS) if (/\bissues\b/.test(code(s.text[f]))) bad.push(f + '：issues の語がある');
  return bad;
});

/* 書き方：ですます、一文に一つ、太字なし、ダッシュは段落に一つまで、二人称なし。 */
function proseLines(t) {
  const out = [];
  let fence = false;
  t.split('\n').forEach((l, k) => {
    if (/^```/.test(l)) { fence = !fence; return; }
    if (fence || /^(#|\||>)/.test(l) || l.trim() === '' || /^\[[^\]]+\]\([^)]+\)$/.test(l.trim())) return;
    out.push([k + 1, l]);
  });
  return out;
}
check('書き方', (s) => {
  const bad = [];
  for (const f of PROSE(s)) {
    const t = s.text[f];
    if (/\*\*/.test(t)) bad.push(f + '：太字');
    for (const [k, l] of proseLines(t)) {
      const body = l.replace(/^- /, '').replace(/`[^`]*`/g, '``');
      if (!/。$/.test(body)) { bad.push(f + ':' + k + '：句点で終わらない'); continue; }
      if ((body.match(/。/g) || []).length !== 1) bad.push(f + ':' + k + '：一行に二つの文');
      if (!/(です|ます|ました|ません|でした)。$/.test(body)) bad.push(f + ':' + k + '：ですます調でない');
      if (/あなた/.test(body)) bad.push(f + ':' + k + '：二人称');
    }
    for (const para of t.split(/\n\s*\n/)) if ((para.match(/——|―|—/g) || []).length > 1) bad.push(f + '：ダッシュが一つの段落に二つ以上');
  }
  const en = s.text['README.en.md'] || '';
  if (/\*\*/.test(en)) bad.push('README.en.md：太字');
  if (/\byou(r|rs|rself)?\b/i.test(en)) bad.push('README.en.md：二人称');
  return bad;
});

/* 散文の数：README・docs の数は、どれも下の表のどれかで、実際の値と合う。 */
function waysTable(t) {
  const lines = String(t || '').split('\n');
  const i = lines.findIndex((l) => /^\| (番号|No\.) \|/.test(l));
  if (i < 0) return [];
  const rows = [];
  for (let k = i + 2; k < lines.length && /^\|/.test(lines[k]); k++) rows.push(lines[k].slice(2, -2).split(' | '));
  return rows;
}
function ruleWays(t) {
  const blk = (/^18\. [\s\S]*?(?=\n\n|\n\S|(?![\s\S]))/m.exec(String(t || '')) || [''])[0].replace(/\n\s+/g, ' ');
  return [...blk.matchAll(/\((\d+)\) (.*?)(?= \(\d+\) |。)/g)].map((x) => [Number(x[1]), x[2].replace(/（[^）]*）/g, '')]);
}
check('散文の数', (s) => {
  const bad = [];
  const m = manifestOf(s);
  const repos = Object.values(m.repos || {}).filter((e) => e.caller !== 'self').length;
  const ja = waysTable(s.text['README.md']), en = waysTable(s.text['README.en.md']);
  const runs = ja.filter((r) => /^回す/.test(r[2])).length, rest = ja.filter((r) => /^回さない/.test(r[2])).length;
  const runsEn = en.filter((r) => /^Runs it/.test(r[2])).length, restEn = en.filter((r) => /^Does not run it/.test(r[2])).length;
  const node = ((Y(s.text[SHARED] || '').jobs || {}).plan || { steps: [] }).steps.find((x) => /^actions\/setup-node@/.test(x.uses || ''));
  const TABLE = [
    [/(\d+) のリポジトリ/g, repos], [/(\d+) of the operator's repositories/g, repos],
    [/Node\.js (\d+)/g, Number(m.common && m.common.node)], [/Node\.js (\d+)/g, Number(node && node.with['node-version'])],
    [/(\d+) のやり方/g, ja.length], [/(\d+) independent ways/g, en.length], [/Of the (\d+) ways/g, en.length],
    [/回すのは (\d+) つ/g, runs], [/the hub runs (\d+)\./g, runsEn], [/残る (\d+) つ/g, rest], [/The remaining (\d+) stay/g, restEn],
    [/（v(\d+)）/g, Number(String(m.version).slice(1))], [/\(v(\d+)\)/g, Number(String(m.version).slice(1))],
    [/CC BY (4)\.0/g, 4], [/CC BY 4\.(0)/g, 0],
  ];
  if (ja.length !== ruleWays(s.text['CLAUDE.md']).length || en.length !== ja.length) bad.push('やり方の表の行の数が、決めごとの数と揃わない');
  ja.forEach((r, k) => { const w = ruleWays(s.text['CLAUDE.md'])[k]; if (Number(r[0]) !== k + 1 || !w || w[1] !== r[1]) bad.push('README.md のやり方の ' + (k + 1) + ' 行目が決めごとと違う'); });
  en.forEach((r, k) => { if (Number(r[0]) !== k + 1) bad.push('README.en.md のやり方の番号'); });
  const kindJa = (x) => (/^回さない/.test(x) ? 'no' : /^回す/.test(x) ? 'run' : /^結果を出す/.test(x) ? 'result' : '?');
  const kindEn = (x) => (/^Does not run it/.test(x) ? 'no' : /^Runs it/.test(x) ? 'run' : /^Produces the result/.test(x) ? 'result' : '?');
  if (!same(ja.map((r) => kindJa(r[2])), en.map((r) => kindEn(r[2])))) bad.push('やり方の表の、ハブの欄が日英で違う');
  for (const f of PROSE(s).concat(['README.en.md'])) {
    let t = String(s.text[f] || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/SHA-256/g, 'SHA');
    t = t.split('\n').map((l) => (/^\| (\d+|番号|No\.) \|/.test(l) ? l.replace(/^\| \d+ \|/, '| |') : l)).join('\n');
    for (const [re, want] of TABLE) {
      t = t.replace(re, (all, n) => { if (Number(n) !== want) bad.push(f + '：「' + all + '」の数が実際（' + want + '）と違う'); return all.replace(/\d/g, '#'); });
    }
    const left = t.match(/\d+/g);
    if (left) bad.push(f + '：数の表に無い数 ' + left.slice(0, 5).join(','));
  }
  return bad;
});

check('決めごとの写し', (s) => {
  const bad = [];
  const t = s.text['CLAUDE.md'] || '';
  const i = t.indexOf('\n16. ');
  const j = t.indexOf('\n\n', i + 1);
  const blk = i < 0 ? '' : t.slice(i + 1, j < 0 ? t.length : j + 1);
  if (sha256(Buffer.from(blk, 'utf8')) !== RULES_16_18) bad.push('CLAUDE.md の決めごと 16〜18 が、写した文と違う');
  if (s.repos) {
    const e = (s.repos[manifestOf(s).entrance] || {})['CLAUDE.md'] || '';
    if (/\n18\. \*\*合っているかを、最低 10 回確かめる。\*\*/.test(e) && !e.includes(blk)) bad.push('正本を持つリポジトリの CLAUDE.md の決めごと 16〜18 と違う');
  }
  return bad;
});

check('README の日英', (s) => {
  const a = s.text['README.md'] || '', b = s.text['README.en.md'] || '';
  const heads = (t) => (t.match(/^## /gm) || []).length;
  const rows = (t) => (t.match(/^\| /gm) || []).length;
  const block = (t) => ((/```\n([\s\S]*?)```/.exec(t) || [, ''])[1].split('\n').length);
  const bad = [];
  if (heads(a) !== heads(b)) bad.push('節の数が日英で違う');
  if (rows(a) !== rows(b)) bad.push('表の行の数が日英で違う');
  if (block(a) !== block(b)) bad.push('検査の囲みの行の数が日英で違う');
  if (!a.includes('[English](./README.en.md)') || !b.includes('[日本語](./README.md)')) bad.push('日英の行き来のリンク');
  return bad;
});

check('依存', (s) => {
  const bad = [];
  const builtins = new Set(Module.builtinModules);
  for (const f of Object.keys(s.text).filter((x) => /^(tools|verification)\/[^/]+\.js$/.test(x))) {
    /* この検査のファイルは、壊し方の文の中にも require を書くので、行の頭の const だけを読む。 */
    const reqs = f === 'verification/check.js' ? s.text[f].match(/^const [^\n]*$/gm).join('\n') : s.text[f];
    for (const mm of reqs.matchAll(/require\('([^']+)'\)/g)) {
      const spec = mm[1];
      if (spec.startsWith('./')) { if (s.text[path.posix.join(path.posix.dirname(f), spec)] === undefined) bad.push(f + '：' + spec + ' が無い'); }
      else if (!builtins.has(spec.replace(/^node:/, ''))) bad.push(f + '：外のパッケージ ' + spec);
    }
  }
  for (const f of Object.keys(s.text)) if (/(^|\/)(package\.json|package-lock\.json|requirements[^/]*\.txt)$/.test(f)) bad.push(f + '：依存の一覧を置く');
  return bad;
});

/* Zenodo の記録（.zenodo.json）。運営者のほかのリポジトリと同じ形：著者は一人で ORCID iD つき、所属を書かない。
 * ライセンスの欄は LICENSE-CODE と同じ MIT で、notes がその欄の掛かる範囲と言語モデル利用の開示を書く。
 * 関連の識別子に DOI を置かない（DOI は受け取ったものだけを書く。このリポジトリは受け取っていない）。 */
check('Zenodo の記録', (s) => {
  const z = J(s.text['.zenodo.json']);
  if (!z) return ['.zenodo.json が読めない'];
  const bad = [];
  if (!/^verification-hub: /.test(z.title || '')) bad.push('題がリポジトリの名で始まらない');
  if (z.upload_type !== 'software' || z.access_right !== 'open') bad.push('upload_type か access_right');
  if (!same(z.creators, [{ name: 'Nemoto, Takuya', orcid: '0009-0000-1406-0547' }])) bad.push('著者（一人、ORCID iD つき、所属なし）');
  if (z.license !== 'mit' || !/^MIT License/.test(s.text['LICENSE-CODE'] || '') || !/^Creative Commons Attribution 4\.0/.test(s.text.LICENSE || '')) bad.push('ライセンスの欄と LICENSE・LICENSE-CODE');
  const n = z.notes || '';
  for (const w of ['Claude is not an author.', 'The workflow, the tools and the checks are MIT (LICENSE-CODE).', 'are CC BY 4.0 (LICENSE).', 'The licence field of this record covers the workflow, the tools and the checks only.', "remain their owners'."]) if (!n.includes(w)) bad.push('notes に「' + w.slice(0, 30) + '」が無い');
  if (!Array.isArray(z.keywords) || !z.keywords.length) bad.push('keywords');
  for (const r of z.related_identifiers || []) if (r.scheme !== 'url' || !/^https:\/\//.test(r.identifier || '')) bad.push('関連の識別子に URL でないもの（DOI を推測で置かない）');
  return bad;
});

check('Dependabot', (s) => {
  const d = Y(s.text['.github/dependabot.yml'] || '');
  return d && d.version === '2' && Array.isArray(d.updates) && d.updates.some((u) => u['package-ecosystem'] === 'github-actions' && u.directory === '/') ? [] : ['Dependabot が GitHub Actions を見ない'];
});

/* ---------- 壊し方 ---------- */

const BREAKS = [];
const brk = (name, desc, mut) => BREAKS.push({ name, desc, mut });
const edit = (f, a, b) => (s) => { const t = clone(s); if (!t.text[f] || !t.text[f].includes(a)) throw new Error('壊す元が無い：' + f + ' の「' + a.slice(0, 40) + '」'); t.text[f] = t.text[f].split(a).join(b); return t; };
const editRe = (f, re, b) => (s) => { const t = clone(s); if (!re.test(t.text[f] || '')) throw new Error('壊す元が無い：' + f + ' ' + re); t.text[f] = t.text[f].replace(re, b); return t; };
const editJSON = (f, fn) => (s) => { const t = clone(s); const v = JSON.parse(t.text[f]); fn(v); t.text[f] = JSON.stringify(v, null, 2) + '\n'; return t; };
const noRepos = (what) => { const e = new Error('並べた置き場に ' + what + ' が無い'); e.needsRepos = true; return e; };
const editRepo = (repo, f, fn) => (s) => { const t = clone(s); if (!t.repos || !t.repos[repo]) throw noRepos(repo); t.repos[repo][f] = fn(t.repos[repo][f]); return t; };

brk('YAML として読める', '引用符の無い文字列に「: 」を書く', edit(SHARED, '        run: |\n          pip install --require-hashes --only-binary=:all: -r "$REQUIREMENTS"\n', '        run: pip install --require-hashes --only-binary=:all: -r "$REQUIREMENTS"\n'));
brk('YAML として読める', '雛形の字下げを崩す', edit(TEMPLATE, '    name: 共通の検査\n', '     name: 共通の検査\n'));
brk('ワークフローの権限', 'contents: write にする', edit(SHARED, 'permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'));
brk('ワークフローの権限', '仕事に権限を足す', edit(SHARED, '    timeout-minutes: 10\n', '    timeout-minutes: 10\n    permissions:\n      contents: read\n'));
brk('ワークフローの権限', '雛形に issues: write を足す', edit(TEMPLATE, 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  issues: write\n'));
brk('鍵を読まない', '手順の env で鍵を読む', edit(SHARED, '          OWN_JOB: ${{ matrix.job.id }}\n', '          OWN_JOB: ${{ matrix.job.id }}\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'));
brk('鍵を読まない', 'workflow_call が鍵を受け取る', edit(SHARED, 'on:\n  workflow_call:\n', 'on:\n  workflow_call:\n    secrets:\n      token:\n        required: false\n'));
brk('鍵を読まない', '呼ぶ側が鍵を渡す', edit(TEMPLATE, '    uses: ', '    secrets: inherit\n    uses: '));
brk('鍵を読まない', '道具が鍵を読む', edit('tools/siblings.js', "GIT_TERMINAL_PROMPT: '0'", "GIT_TERMINAL_PROMPT: '0', T: process.env.GITHUB_TOKEN"));
brk('アクションを固める', 'checkout を版の名で指す', editRe(SHARED, /actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'));
brk('アクションを固める', '版の注釈を外す', editRe(SHARED, /(actions\/setup-python@[0-9a-f]{40}) # v[\d.]+/g, '$1'));
brk('アクションを固める', 'setup-node を受付と違う値にする', editRe(SHARED, /actions\/setup-node@[0-9a-f]{40}/g, 'actions/setup-node@' + 'a'.repeat(40)));
brk('アクションを固める', '雛形が main を呼ぶ', editRe(TEMPLATE, /shared-check\.yml@[0-9a-f]{40}/, 'shared-check.yml@main'));
brk('アクションを固める', '雛形の版の注釈を変える', editRe(TEMPLATE, / # v\d+\s*$/m, ' # v9'));
brk('アクションを固める', '手順で uses: ./ を使う', edit(SHARED, "      - id: plan\n", "      - uses: ./\n      - id: plan\n"));
brk('時間の上限', '上限を外す', edit(SHARED, '    timeout-minutes: 10\n', ''));
brk('時間の上限', '上限を 90 分にする', editRe(SHARED, /timeout-minutes: 60/, 'timeout-minutes: 90'));
brk('時間の上限', '呼ぶ側を呼ぶ仕事でなくする', editRe(SELFTEST, /    uses: \.\/\.github\/workflows\/shared-check\.yml\n/, '    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n'));
brk('run の行に式を書かない', 'run の行に式を書く', edit(SHARED, '          node "$tools/own.js" "$OWN_JOB"', '          node "$tools/own.js" "${{ matrix.job.id }}"'));
brk('run の行に式を書かない', '出来事の題を env に入れる', edit(SHARED, '          OWN_JOB: ${{ matrix.job.id }}\n', '          OWN_JOB: ${{ matrix.job.id }}\n          TITLE: ${{ github.event.pull_request.title }}\n'));
brk('run の行に式を書かない', '出来事の ref を path に使う', edit(SHARED, '          path: .shared-check-source\n', '          path: ${{ github.event.pull_request.head.ref }}\n'));
brk('同時実行の組', 'ワークフローの全体に組を置く', edit(SHARED, 'permissions:\n  contents: read\njobs:\n', 'permissions:\n  contents: read\nconcurrency: x\njobs:\n'));
brk('同時実行の組', 'matrix の仕事に組を置く', edit(SHARED, '    timeout-minutes: 60\n    steps:\n      - name: このワークフローの置き場とコミットを確かめる\n        env:\n          SOURCE_REPOSITORY: ${{ job.workflow_repository }}\n          SOURCE_SHA: ${{ job.workflow_sha }}\n        run: |\n          [[ "$SOURCE_REPOSITORY" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo \'job.workflow_repository を読めない\'; exit 1; }\n          [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo \'job.workflow_sha を読めない\'; exit 1; }\n      # 呼んだ',
  '    timeout-minutes: 60\n    concurrency: own\n    steps:\n      - name: このワークフローの置き場とコミットを確かめる\n        env:\n          SOURCE_REPOSITORY: ${{ job.workflow_repository }}\n          SOURCE_SHA: ${{ job.workflow_sha }}\n        run: |\n          [[ "$SOURCE_REPOSITORY" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { echo \'job.workflow_repository を読めない\'; exit 1; }\n          [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo \'job.workflow_sha を読めない\'; exit 1; }\n      # 呼んだ'));
brk('同時実行の組', '呼ぶ側の組を外す', edit(TEMPLATE, "    concurrency:\n      group: ${{ github.workflow }}-${{ github.ref }}\n      cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n", ''));
brk('同時実行の組', 'main の実行も取り消す', edit(SELFTEST, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'));
brk('起こす出来事', 'pull_request_target で起こす', edit(TEMPLATE, '  pull_request:\n', '  pull_request_target:\n'));
brk('起こす出来事', 'workflow_run で起こす', edit(SELFTEST, '  workflow_dispatch:\n', '  workflow_dispatch:\n  workflow_run:\n    workflows: [x]\n'));
brk('起こす出来事', '再利用のワークフローを push でも起こす', edit(SHARED, 'on:\n  workflow_call:\n', 'on:\n  workflow_call:\n  push:\n'));
brk('起こす出来事', '写しの呼び出しの PR を絞る', edit(LOCAL, '  pull_request:\n', "  pull_request:\n    paths: ['x']\n"));
brk('checkout が鍵を残さない', '一つの checkout が鍵を残す', editRe(SHARED, /          path: source\n          persist-credentials: false\n/, '          path: source\n'));
brk('checkout が鍵を残さない', 'persist-credentials を true にする', editRe(SHARED, /persist-credentials: false/, 'persist-credentials: true'));
brk('道具を同じコミットから読む', '道具を main から読む', editRe(SHARED, /          ref: \$\{\{ job\.workflow_sha \}\}\n          path: \.shared-check-source/, '          ref: main\n          path: .shared-check-source'));
brk('道具を同じコミットから読む', 'コミットの値を確かめない', editRe(SHARED, /          \[\[ "\$SOURCE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| \{ echo 'job\.workflow_sha を読めない'; exit 1; \}\n          echo/, '          echo'));
brk('道具を同じコミットから読む', '呼んだリポジトリをマージの試しのコミットで取り出す', editRe(SHARED, /          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n          fetch-depth: \$\{\{ matrix/, '          fetch-depth: ${{ matrix'));
brk('道具を同じコミットから読む', '道具を外へ移さない', edit(SHARED, 'run: mv .shared-check-source "$RUNNER_TEMP/shared-check-source"', 'run: cp -r .shared-check-source "$RUNNER_TEMP/shared-check-source"'));
brk('リポジトリの名を書かない', 'ワークフローに名を書く', edit(SHARED, '# このファイルと道具には', '# cpsbvbng26-dotcom のこのファイルと道具には'));
brk('リポジトリの名を書かない', '道具に名を書く', edit('tools/common.js', "'use strict';", "'use strict';\n// solitary-school"));
brk('目録の形', 'caller を知らない値にする', editJSON('repos.json', (m) => { m.repos['errata-check'].caller = 'maybe'; }));
brk('目録の形', '仕事に式を入れる', editJSON('repos.json', (m) => { m.repos['solitary-school'].jobs[0].steps[0].run = 'echo ${{ github.event.issue.title }}'; }));
brk('目録の形', '同じ id の仕事を二つにする', editJSON('repos.json', (m) => { m.repos['naval-gazette-notes'].jobs.push(m.repos['naval-gazette-notes'].jobs[0]); }));
brk('目録の形', 'ハブを呼ぶ欄に兄弟をすべて取る手順を足す', editJSON('repos.json', (m) => { m.repos['deposit-check'].jobs[0].steps.unshift({ siblings: '../repos' }); }));
brk('目録の形', 'not_carried の理由を空にする', editJSON('repos.json', (m) => { const k = Object.keys(m.repos['sophaxis'].not_carried)[0]; m.repos['sophaxis'].not_carried[k].why = ''; }));
brk('目録の形', 'copies に正本の外の道を足す', editJSON('repos.json', (m) => { m.repos['trinity-operator'].copies.push('README.md'); }));
brk('目録の形', 'runner を知らない値にする', editJSON('repos.json', (m) => { m.repos['trinity-infinity'].jobs[0].runner = 'windows-latest'; }));
brk('目録の形', '隣の道で上へ出る', editJSON('repos.json', (m) => { const st = m.repos['trinity-operator'].jobs[0].steps.find((x) => x.sibling); st.path = '../x'; }));
brk('目録と各リポジトリの CI', '手順を一つ変える', editJSON('repos.json', (m) => { m.repos['errata-check'].jobs.find((j) => j.id.startsWith('verify.yml/verify/')).steps[1].run = 'python3 tests/check_tool.py --quick'; }));
brk('目録と各リポジトリの CI', '手順を一つ外す', editJSON('repos.json', (m) => { m.repos['cpsbvbng26-dotcom'].jobs.find((j) => j.id === 'verify.yml/keyboard').steps.pop(); }));
brk('目録と各リポジトリの CI', 'Python の版を変える', editJSON('repos.json', (m) => { m.repos['self-correction'].jobs.find((j) => j.python).python = '3.13'; }));
brk('目録と各リポジトリの CI', 'fetch-depth を変える', editJSON('repos.json', (m) => { m.repos['sophaxis'].jobs[0]['fetch-depth'] = '1'; }));
brk('目録と各リポジトリの CI', '仕事を目録から外す', editJSON('repos.json', (m) => { m.repos['golden-window-resolution'].jobs.pop(); }));
brk('目録と各リポジトリの CI', '写せない仕事の理由を偽る', editJSON('repos.json', (m) => { m.repos['deposit-check'].not_carried['check.yml/action'].kind = 'network'; }));
brk('目録と各リポジトリの CI', 'CI に仕事を足す', editRepo('justice-and-algorithms', '.github/workflows/verify.yml', (t) => t + '\n  extra:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n      - run: node x.js\n'));
brk('目録と各リポジトリの CI', 'CI の手順を一つ変える', editRepo('naval-gazette-notes', '.github/workflows/verify.yml', (t) => t.replace('run: python3 data/check.py', 'run: python3 data/check.py --fast')));
brk('横断の手順と正本の CI', '横断の手順を一つ外す', edit(SHARED, '        run: node verification/check_ecosystem.js\n', '        run: echo\n'));
brk('横断の手順と正本の CI', 'pip を固めずに入れる', edit(SHARED, 'pip install --require-hashes --only-binary=:all: -r "$REQUIREMENTS"', 'pip install numpy pypdf'));
brk('横断の手順と正本の CI', '正本の横断の手順を変える', editRepo('cpsbvbng26-dotcom', '.github/workflows/ecosystem.yml', (t) => t.replace('run: node verification/check_all.js', 'run: node verification/check_all.js --quick')));
brk('正本の写し', 'SECURITY.md を一字変える', edit('SECURITY.md', '7 日以内', '8 日以内'));
brk('正本の写し', 'copies.json の値を一つ変える', editRe(COPIES_JSON, /"SECURITY\.md": "[0-9a-f]/, '"SECURITY.md": "x'));
brk('正本の写し', '並べた正本だけを変える', editRepo('cpsbvbng26-dotcom', '.github/checked-intake/verify.js', (t) => t + '\n'));
brk('呼ぶ側の雛形', '雛形の値を履歴に無いものにする', editRe(TEMPLATE, /shared-check\.yml@[0-9a-f]{40}/, 'shared-check.yml@' + '0'.repeat(40)));
brk('呼ぶ側の雛形', '雛形の値を最初のコミットにする', (s) => { const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')[0]; return editRe(TEMPLATE, /shared-check\.yml@[0-9a-f]{40}/, 'shared-check.yml@' + first)(s); });
brk('呼ぶ側の雛形', '雛形にだけ定期を足す', edit(TEMPLATE, '  workflow_dispatch:\n', "  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * 0'\n"));
brk('呼ぶ側の雛形', '写しの呼び出しの名を変える', edit(LOCAL, '    name: 共通の検査\n', '    name: 別の検査\n'));
brk('各リポジトリに置いた呼び出し', '呼ぶ側が雛形と違う hub.yml を持つ', (s) => { const t = clone(s); if (!t.repos || !t.repos['solitary-school']) throw noRepos('リポジトリ'); t.repos['solitary-school']['.github/workflows/hub.yml'] = t.text[TEMPLATE].replace('cancel-in-progress', 'cancel-in-progres'); return t; });
brk('各リポジトリに置いた呼び出し', '呼ぶ側の値が履歴に無い', (s) => { const t = clone(s); if (!t.repos || !t.repos['errata-check']) throw noRepos('リポジトリ'); t.repos['errata-check']['.github/workflows/hub.yml'] = t.text[TEMPLATE].replace(/@[0-9a-f]{40}/, '@' + 'f'.repeat(40)); return t; });
brk('各リポジトリに置いた呼び出し', '写しで動くリポジトリの道具の写しが違う', (s) => {
  const t = clone(s); const m = manifestOf(t); const n = Object.keys(m.repos).find((x) => m.repos[x].caller === 'self-contained');
  if (!t.repos || !t.repos[n]) throw noRepos('リポジトリ');
  t.repos[n]['.github/workflows/shared-check.yml'] = t.text[SHARED]; t.repos[n]['.github/workflows/shared.yml'] = t.text[LOCAL];
  for (const f of TOOLS) t.repos[n]['.github/shared-check/' + path.basename(f)] = t.text[f];
  t.repos[n]['.github/shared-check/repo.json'] = JSON.stringify(m.repos[n]);
  t.repos[n]['.github/shared-check/own.js'] += '\n';
  return t;
});
brk('各リポジトリに置いた呼び出し', 'ハブを呼ぶリポジトリが写しも持つ', editRepo('trinity-infinity', '.github/shared-check/own.js', () => 'x'));
brk('道具の振る舞い', 'own が落ちた手順のあとも続ける', edit('tools/own.js', "if (r.status !== 0) return { ok: false", "if (r.status !== 0 && false) return { ok: false"));
brk('道具の振る舞い', 'own が pipefail を付けない', edit('tools/own.js', "'-o', 'pipefail', ", ''));
brk('道具の振る舞い', 'common がメールアドレスを見ない', edit('tools/common.js', "const MAIL = new RegExp('[A-Za-z0-9._%+-]+' + '@'", "const MAIL = new RegExp('[A-Za-z0-9._%+-]+' + '@@'"));
brk('道具の振る舞い', 'common が UID の行を外さない', edit('tools/common.js', "if (/\\.ics$/.test(f) && /^UID:/.test(line)) return;", ''));
brk('道具の振る舞い', 'common が注釈の中のリンクも見る', edit('tools/common.js', "comment = true;\n      rest = rest.slice(b + 4);", "rest = rest.slice(b + 4);"));
brk('道具の振る舞い', 'common が写しの違いを見ない', edit('tools/common.js', "else if (!same) bad.写し.push", "else if (false) bad.写し.push"));
brk('道具の振る舞い', 'common が壊れた活用を見ない', edit('tools/common.js', "if (line.includes(w)) bad.走査", "if (false) bad.走査"));
brk('道具の振る舞い', 'plan が写しで動く欄をハブの置き方で通す', (s) => edit('tools/lib.js', "if (!['hub', 'self'].includes(e.caller))", 'if (false)')(edit('tools/lib.js', "if (e.caller === 'self-contained') fail(", 'if (false) fail(')(s)));
brk('道具の振る舞い', 'lib.load が目録の無いのを通す', edit('tools/lib.js', "return fail('目録が無い（'", "return { mode: 'hub', manifest: { repos: {} } }; void ('目録が無い（'"));
brk('メールアドレス', 'README に宛先を書く', edit('README.md', 'Claude は著者ではありません。', 'Claude は著者ではありません。\n宛先は someone' + '@' + 'example.org です。'));
brk('メールアドレス', '目録に宛先を書く', editJSON('repos.json', (m) => { m._.push('x' + '@' + 'example.com'); }));
brk('所属と学校の名・肩書き', 'README に学校の名を書く', edit('README.md', 'Claude は著者ではありません。', 'Claude は著者ではありません。\n運営者は ZEN' + '大学の学生です。'));
brk('所属と学校の名・肩書き', '英語の README に肩書きを書く', edit('README.en.md', 'Claude is not an author.', 'Claude is not an author. The operator is an independent ' + 'researcher.'));
brk('分けておくリポジトリの名', '散文に名を書く', (s) => { const m = manifestOf(s); const n = Object.keys(m.repos).find((x) => m.repos[x].caller === 'self-contained'); return edit('docs/decisions.md', '## 分けておくリポジトリ\n', '## 分けておくリポジトリ\n\n' + n + ' のことです。\n')(s); });
brk('分けておくリポジトリの名', '片仮名で書く', edit('README.md', '## 写しの置き方\n', '## 写しの置き方\n\nヌス' + 'クァマのことです。\n'));
brk('分けておくリポジトリの名', '目録の注釈に名を書く', (s) => { const m = manifestOf(s); const n = Object.keys(m.repos).find((x) => m.repos[x].caller === 'self-contained'); return editJSON('repos.json', (v) => { v._.push(n); })(s); });
brk('利用者に仕事を作らない', 'README に命令を書く', edit('README.md', 'Claude は著者ではありません。', 'Claude は著者ではありません。\n値の確かめを' + 'してください。'));
brk('利用者に仕事を作らない', '英語の README に持ち主の仕事を書く', edit('README.en.md', 'Claude is not an author.', 'Claude is not an author. This needs the ' + 'owner.'));
brk('issue を読まない', '道具が issue を読む', edit('tools/siblings.js', "const SERVER = 'https://github.com/';", "const SERVER = 'https://github.com/';\nconst ISSUES = 'https://api.github.com/repos/x/y/issues';"));
brk('issue を読まない', 'ワークフローが issues の権限を持つ', edit(SHARED, 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  issues: read\n'));
brk('書き方', '太字を使う', edit('README.md', '入力も鍵も渡しません。', '**入力も鍵も渡しません。**'));
brk('書き方', 'である調で書く', edit('docs/decisions.md', 'マージはマージコミットで行います。', 'マージはマージコミットで行う。'));
brk('書き方', '一行に二つの文', edit('README.md', '入力も鍵も渡しません。\n', '入力も鍵も渡しません。鍵は要りません。\n'));
brk('書き方', 'ダッシュを重ねる', edit('docs/decisions.md', 'マージはマージコミットで行います。', 'マージは——いつも——マージコミットで行います。'));
brk('書き方', '英語で二人称を使う', edit('README.en.md', 'No inputs and no secrets are passed.', 'You pass no inputs and no secrets.'));
brk('散文の数', 'リポジトリの数を変える', edit('README.md', '運営者の 15 のリポジトリ', '運営者の 16 のリポジトリ'));
brk('散文の数', '回すやり方の数を変える', edit('README.en.md', 'the hub runs 5.', 'the hub runs 6.'));
brk('散文の数', '表に無い数を書く', edit('docs/decisions.md', 'マージはマージコミットで行います。', 'マージは 3 回目からマージコミットで行います。'));
brk('散文の数', 'やり方の表の一行を変える', edit('README.md', '| 4 | 元の資料と差分を読み直す |', '| 4 | 元の資料を読み直す |'));
brk('散文の数', '日英でハブの欄を違える', edit('README.en.md', '| 6 | Recompute the numbers with a separate script | Does not run it |', '| 6 | Recompute the numbers with a separate script | Runs it |'));
brk('散文の数', '版を変える', edit('README.md', '注釈の版（v1）', '注釈の版（v2）'));
brk('決めごとの写し', '決めごと 18 の回数を変える', edit('CLAUDE.md', '少なくとも 10 回、別々のやり方で', '少なくとも 3 回、別々のやり方で'));
brk('決めごとの写し', '決めごと 16 を一字変える', edit('CLAUDE.md', '結果の責任は Claude が負う。', '結果の責任は Claude が持つ。'));
brk('README の日英', '英語の節を一つ外す', edit('README.en.md', '## Security and errors\n', ''));
brk('README の日英', '日本語の表に一行足す', edit('README.md', '| 権限は contents: read だけ |', '| 足した行 | 足した行 |\n| 権限は contents: read だけ |'));
brk('依存', '外のパッケージを読む', edit('tools/plan.js', "const lib = require('./lib.js');", "const lib = require('./lib.js');\nconst yaml = require('js-yaml');"));
brk('依存', 'package.json を置く', (s) => { const t = clone(s); t.text['package.json'] = '{}'; return t; });
brk('Zenodo の記録', '著者に所属を足す', editJSON('.zenodo.json', (z) => { z.creators[0].affiliation = 'x'; }));
brk('Zenodo の記録', '開示を外す', edit('.zenodo.json', ' Claude is not an author.', ''));
brk('Zenodo の記録', 'ライセンスの欄を cc-by-4.0 にする', edit('.zenodo.json', '"license": "mit"', '"license": "cc-by-4.0"'));
brk('Zenodo の記録', '関連に DOI を置く', editJSON('.zenodo.json', (z) => { z.related_identifiers.push({ identifier: '10.5281/zenodo.1', relation: 'isPartOf', scheme: 'doi' }); }));
brk('Zenodo の記録', 'upload_type を変える', edit('.zenodo.json', '"upload_type": "software"', '"upload_type": "dataset"'));
brk('Dependabot', 'GitHub Actions を見なくする', edit('.github/dependabot.yml', 'package-ecosystem: github-actions', 'package-ecosystem: npm'));

/* ---------- 回す ---------- */

function run(s, list) {
  const res = [];
  for (const c of list) {
    if (c.needsRepos && !s.repos) { res.push({ c, skipped: true }); continue; }
    let bad;
    try { bad = c.fn(s); } catch (e) { bad = ['検査が投げた：' + e.message]; }
    res.push({ c, bad });
  }
  return res;
}

function main() {
  const s = load();
  let fail = 0;
  const res = run(s, CHECKS);
  for (const r of res) {
    if (r.skipped) { console.log('  －  ' + r.c.name + '（--repos で回る）'); continue; }
    if (r.bad.length) { fail++; console.log('  落  ' + r.c.name); r.bad.slice(0, 12).forEach((b) => console.log('        ' + b)); if (r.bad.length > 12) console.log('        ほか ' + (r.bad.length - 12) + ' 件'); }
    else console.log('  通  ' + r.c.name);
  }
  for (const n of NOTES) console.log('  注  ' + n);
  const ran = res.filter((r) => !r.skipped).length;
  console.log('\n' + ran + ' の検査のうち、' + (ran - fail) + ' が通りました' + (s.repos ? '（並べたリポジトリ ' + Object.keys(s.repos).length + '）' : '（並べたリポジトリなし）') + '。');
  if (BREAK) {
    console.log('\n壊して確かめる');
    let missed = 0, used = 0;
    for (const b of BREAKS) {
      const c = CHECKS.find((x) => x.name === b.name);
      if (!c) { missed++; console.log('  落  知らない検査の名：' + b.name); continue; }
      if (c.needsRepos && !s.repos) continue;
      let t;
      try { t = b.mut(s); } catch (e) { if (e.needsRepos && !s.repos) continue; missed++; console.log('  落  ' + b.name + '：' + b.desc + '（壊せない：' + e.message + '）'); continue; }
      used++;
      let bad;
      try { bad = c.fn(t); } catch (e) { bad = ['投げた']; }
      if (bad.length) console.log('  通  ' + b.name + '：' + b.desc);
      else { missed++; console.log('  落  ' + b.name + '：' + b.desc + '（壊しても通った）'); }
    }
    const without = CHECKS.filter((c) => (!c.needsRepos || s.repos) && !BREAKS.some((b) => b.name === c.name));
    for (const c of without) { missed++; console.log('  落  壊し方の無い検査：' + c.name); }
    console.log('\n' + used + ' の壊し方のうち、' + (used - (missed - without.length)) + ' で落ちました。');
    if (missed) fail++;
  }
  if (fail) process.exit(1);
}

if (require.main === module) main();

module.exports = { CHECKS, BREAKS, load };
