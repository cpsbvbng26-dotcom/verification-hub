/* 共通の検査の最初の仕事。呼んだリポジトリの欄を目録から読み、後の仕事に渡す値を出す。
 *
 *     node tools/plan.js
 *
 * 出す値（GITHUB_OUTPUT）:
 *   name          呼んだリポジトリの名
 *   jobs          そのリポジトリの検査の仕事の並び（matrix に渡す JSON）。一つも無ければ []
 *   common        目録のリポジトリを並べるか（ハブの置き方なら true、写しの置き方なら false）
 *   cross         横断の検査（check_all.js と check_ecosystem.js）を回すか（目録の cross が true の欄だけ true）
 *   entrance      横断の検査と正本を持つリポジトリの名（写しの置き方では空）
 *   requirements  横断の検査が pip で入れる、版とハッシュを固めた一覧の道（写しの置き方では空） */

'use strict';

const lib = require('./lib.js');

function plan(loaded, name) {
  const e = lib.entryFor(loaded, name);
  const jobs = e.jobs || [];
  const seen = new Set();
  for (const j of jobs) {
    lib.checkJob(j, name);
    if (seen.has(j.id)) lib.fail(name + '：同じ id の仕事が二つ ' + j.id);
    seen.add(j.id);
    if (j.steps.some((s) => s.siblings !== undefined) && e.caller !== 'self') lib.fail(name + '：兄弟をすべて取る手順は、ハブ自身の欄にだけ置ける');
  }
  const out = {
    name,
    jobs: JSON.stringify(jobs.map((j) => ({ id: j.id, runner: j.runner, python: j.python || '', node: j.node || '', 'fetch-depth': Number(j['fetch-depth']) }))),
    common: String(loaded.mode === 'hub'),
    cross: String(loaded.mode === 'hub' && e.cross === true),
    entrance: '',
    requirements: '',
  };
  if (loaded.mode === 'hub') {
    const m = loaded.manifest;
    if (!lib.NAME.test(m.entrance || '') || !m.repos[m.entrance]) lib.fail('目録の entrance');
    if (!lib.safePath(m.common.requirements, false)) lib.fail('目録の common.requirements');
    out.entrance = m.entrance;
    out.requirements = 'repos/' + m.entrance + '/' + m.common.requirements;
  }
  return out;
}

if (require.main === module) {
  try {
    const loaded = lib.load(__dirname);
    const me = lib.caller();
    if (loaded.mode === 'hub' && me.owner !== loaded.manifest.owner) lib.fail('目録の持ち主と、呼んだリポジトリの持ち主が違う');
    const out = plan(loaded, me.name);
    for (const [k, v] of Object.entries(out)) lib.output(k, v);
    console.log(me.name + '：検査の仕事 ' + JSON.parse(out.jobs).length + '、横断の検査 ' + (out.cross === 'true' ? 'あり' : 'なし'));
  } catch (e) {
    console.error(e.hub ? e.message : e.stack);
    process.exit(1);
  }
}

module.exports = { plan };
