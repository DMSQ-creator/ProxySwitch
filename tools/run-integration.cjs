'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const script of ['verify-diagnostics.cjs', 'verify-websockets.cjs', 'verify-auto-recording.cjs', 'verify-reliability.cjs', 'verify-experience.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
