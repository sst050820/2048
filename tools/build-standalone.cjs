'use strict';
// The upstream build pipeline embeds its own CSS, fonts and seven scripts.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),target=path.join(root,'凝合.html');
cp.execFileSync(process.execPath,[path.join(__dirname,'build-single.js'),target],{stdio:'inherit'});
for(const name of ['index.html'])fs.copyFileSync(target,path.join(root,name));
const b=fs.readFileSync(target);console.log(JSON.stringify({entry:target,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),identicalEntries:2}));
