// Keep a live root for taskkill /T even when the command's shell exits first.
// The parent always terminates this supervisor and its descendants after outcome.
import {spawn} from 'node:child_process';
const keepAlive=setInterval(()=>{},60000);
const child=spawn(process.argv[2],{shell:process.env.ComSpec||'cmd.exe',windowsHide:true,stdio:['ignore','inherit','inherit']});
child.once('error',()=>process.send?.({startFailed:true}));
child.once('exit',(exitCode,signal)=>process.send?.({exitCode,signal}));
process.once('disconnect',()=>{clearInterval(keepAlive);child.kill();process.exitCode=1;});
