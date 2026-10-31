import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const helper = resolve('dist/vc-mix/data/helper');
const child = spawn(resolve(helper, 'node.exe'), [resolve(helper, 'src/obs/helper.js')], { cwd: helper, stdio: ['pipe', 'pipe', 'pipe'] });
let pending = Buffer.alloc(0);
let audioFrames = 0;
let started = false;
const timeout = setTimeout(() => { console.error('Helper did not complete its audio smoke test.'); child.kill(); }, 15000);
child.stdout.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE()) {
    const length = pending.readUInt32LE();
    const frame = pending.subarray(4, 4 + length);
    if (frame[0] === 1) {
      const event = JSON.parse(frame.subarray(1).toString());
      console.log(event);
      if (event.type === 'ready' && !started) {
        started = true;
        child.stdin.write('{"command":"test"}\n');
        setTimeout(() => child.stdin.end(), 1000);
      }
    }
    else audioFrames += 1;
    pending = pending.subarray(4 + length);
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => { clearTimeout(timeout); console.log({ code, audioFrames }); if (code !== 0 || !audioFrames) process.exitCode = 1; });
