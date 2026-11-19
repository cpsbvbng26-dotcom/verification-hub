/* 呼んだリポジトリの検査の仕事を一つ回す。
 *
 *     node tools/own.js <仕事の id>
 *
 * 目録の仕事の手順を、上から順に回す。手順は、そのリポジトリの CI のワークフローの手順を写したものである。
 *   run       bash で回す。GitHub Actions の run と同じく -e と pipefail を付ける。env があれば足す。
 *   sibling   隣のリポジトリを path に複製する（ref があればその値へ移る）。
 *   siblings  目録のすべてのリポジトリを、その置き場に複製する（ハブ自身の欄だけ）。
 * 一つでも落ちれば、そこで止まって落ちる。CI の run が落ちたら後ろの手順が回らないのと同じである。
 * 作業の場所は、呼んだリポジトリを取り出した場所（いまの場所）で、workdir があればその下である。 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const lib = require('./lib.js');

function run(job, ctx) {
  const cwd = job.workdir ? path.join(process.cwd(), job.workdir) : process.cwd();
  let k = 0;
  for (const s of job.steps) {
    k++;
    const head = '[' + k + '/' + job.steps.length + '] ';
    if (s.run !== undefined) {
      console.log('\n' + head + s.run.split('\n')[0] + (s.run.includes('\n') ? ' …' : ''));
      const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', s.run], {
        cwd, stdio: 'inherit', env: Object.assign({}, process.env, s.env || {}),
      });
      if (r.status !== 0) return { ok: false, at: k, why: 'run が ' + (r.status === null ? r.signal : r.status) + ' で終わった' };
    } else if (s.sibling !== undefined) {
      console.log('\n' + head + '隣 ' + s.sibling + ' → ' + s.path + (s.ref ? ' @ ' + s.ref : ''));
      ctx.clone(s.sibling, path.join(cwd, s.path), s.ref);
    } else if (s.siblings !== undefined) {
      console.log('\n' + head + '目録のすべてのリポジトリ → ' + s.siblings);
      ctx.all(path.resolve(cwd, s.siblings));
    }
  }
  return { ok: true };
}

if (require.main === module) {
  try {
    const id = process.argv[2];
    if (!id) lib.fail('仕事の id を一つ渡す');
    const loaded = lib.load(__dirname);
    const me = lib.caller();
    const e = lib.entryFor(loaded, me.name);
    const job = (e.jobs || []).find((j) => j.id === id);
    if (!job) lib.fail(me.name + ' に仕事 ' + id + ' が無い');
    lib.checkJob(job, me.name);
    /* 隣の複製は、ハブの置き方でだけ要る。写しの置き方の目録が隣を求めれば、ここで落ちる。 */
    const ctx = {
      clone: (full, dest, ref) => {
        if (loaded.mode !== 'hub') lib.fail('写しの置き方では、隣を複製しない');
        require('./siblings.js').clone(full, dest, ref);
      },
      all: (dir) => {
        if (loaded.mode !== 'hub' || e.caller !== 'self') lib.fail('目録のすべてを並べるのは、ハブ自身の欄だけ');
        require('./siblings.js').all(loaded.manifest, me.owner, me.name, dir);
      },
    };
    const r = run(job, ctx);
    if (!r.ok) { console.error('\n' + id + '：' + r.at + ' 番目の手順で落ちました（' + r.why + '）。'); process.exit(1); }
    console.log('\n' + id + '：' + job.steps.length + ' の手順がすべて通りました。');
  } catch (e) {
    console.error(e.hub ? e.message : e.stack);
    process.exit(1);
  }
}

module.exports = { run };
