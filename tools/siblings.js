/* 目録にあるリポジトリを、読むだけの複製として一か所に並べる。
 *
 *     node tools/siblings.js <置き場>
 *
 * 呼んだリポジトリのほかの、目録のすべてのリポジトリを <置き場>/<名> に複製する。履歴はすべて取る
 * （横断の検査が、最初のコミットの日付やマージの本文を git の記録から読むため）。
 * 鍵は使わない。公開のリポジトリを https で読むだけで、git の資格情報の助け手も切る。
 * 写しの置き方では使わない（目録に兄弟が無い）。 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const SERVER = 'https://github.com/';

function git(args, cwd) {
  execFileSync('git', ['-c', 'credential.helper=', '-c', 'advice.detachedHead=false'].concat(args), {
    cwd, stdio: ['ignore', 'ignore', 'inherit'], env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
  });
}

/* full は「持ち主/名」。ref が 40 桁なら、複製のあとその値へ移る。 */
function clone(full, dest, ref) {
  if (!lib.FULL.test(full)) lib.fail('リポジトリの名 ' + full);
  if (ref !== undefined && !/^[0-9a-f]{40}$/.test(ref)) lib.fail('ref ' + ref);
  if (fs.existsSync(dest)) lib.fail(dest + ' がもうある');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(['clone', '--quiet', SERVER + full, dest]);
  if (ref !== undefined) git(['checkout', '--quiet', ref], dest);
}

/* 目録のすべてのリポジトリ（呼んだものを除く）を dir に並べる。 */
function all(manifest, owner, me, dir) {
  const names = Object.keys(manifest.repos).filter((n) => n !== me);
  for (const n of names) {
    if (!lib.NAME.test(n)) lib.fail('目録の名 ' + n);
    clone(owner + '/' + n, path.join(dir, n));
  }
  return names;
}

if (require.main === module) {
  try {
    const dir = process.argv[2];
    if (!dir) lib.fail('置き場を一つ渡す');
    const loaded = lib.load(__dirname);
    if (loaded.mode !== 'hub') lib.fail('写しの置き方では、兄弟を並べない');
    const me = lib.caller();
    if (me.owner !== loaded.manifest.owner) lib.fail('目録の持ち主と、呼んだリポジトリの持ち主が違う');
    const names = all(loaded.manifest, me.owner, me.name, path.resolve(dir));
    console.log(names.length + ' のリポジトリを ' + dir + ' に複製しました。');
  } catch (e) {
    console.error(e.hub ? e.message : e.stack);
    process.exit(1);
  }
}

module.exports = { clone, all };
