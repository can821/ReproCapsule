import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from './helpers.js';
import { localiseWithSourceMaps } from '../src/source-maps.js';

test('local v3 maps rank retained TypeScript sources and preserve generated evidence', async t => {
  const root = await temporary(t);
  await mkdir(path.join(root,'dist')); await mkdir(path.join(root,'src'));
  await writeFile(path.join(root,'src/app.ts'),'throw new Error("target");');
  const payload={version:3,sources:['../src/app.ts'],names:[],mappings:'AAAA'};
  await writeFile(path.join(root,'dist/app.js.map'),JSON.stringify(payload));
  const generated=path.join(root,'dist/app.js');
  const result={stdout:'',stderr:`Error: target\n    at ${generated}:1:1`};
  for(const ref of ['app.js.map',`data:application/json;base64,${Buffer.from(JSON.stringify(payload)).toString('base64')}`]){
    await writeFile(generated,`throw new Error("target");\n//# sourceMappingURL=${ref}`);
    const d=await localiseWithSourceMaps(result,root,['src/app.ts'],{});
    assert.equal(d.locations[0].file,'src/app.ts');assert.equal(d.locations[0].line,1);
    assert.deepEqual(d.locations[0].generated,{file:'dist/app.js',line:1,column:1});
    assert.equal(d.sourceMaps.mappedLocations,1);
  }
  assert.equal((await localiseWithSourceMaps(result,root,[],{})).locations.length,0);
});
test('malformed, remote and escaping source maps never become project evidence', async t => {
  const root=await temporary(t), outside=await temporary(t), generated=path.join(root,'app.js');
  await writeFile(path.join(outside,'external.map'),'{}');
  await symlink(path.join(outside,'external.map'),path.join(root,'escape.map'));
  for(const ref of ['https://example.invalid/map','escape.map','bad.map']){
    await writeFile(path.join(root,'bad.map'),'not json');
    await writeFile(generated,`throw 1;\n//# sourceMappingURL=${ref}`);
    const d=await localiseWithSourceMaps({stdout:'',stderr:`    at ${generated}:1:1`},root,['app.js'],{});
    assert.equal(d.locations[0].file,'app.js');assert.equal(d.sourceMaps.mappedLocations,0);
  }
});
