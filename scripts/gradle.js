#!/usr/bin/env node
/**
 * Cross-platform Gradle wrapper runner.
 *
 * `./gradlew` (POSIX shell script) does not exist as an executable on
 * Windows — it needs `gradlew.bat`. This helper picks the right launcher
 * for the current OS so npm/bun scripts stay identical on Linux and
 * Windows:
 *
 *   node scripts/gradle.js assembleRelease
 *   node scripts/gradle.js assembleDebug
 *
 * Always targets apps/mobile/android regardless of the caller's CWD.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const androidDir = path.resolve(__dirname, '..', 'apps', 'mobile', 'android');
const isWindows = process.platform === 'win32';

if (!fs.existsSync(androidDir)) {
  console.error(`[gradle] Android project directory not found: ${androidDir}`);
  process.exit(1);
}

const launcher = isWindows ? 'gradlew.bat' : path.join(androidDir, 'gradlew');
if (!fs.existsSync(isWindows ? path.join(androidDir, 'gradlew.bat') : launcher)) {
  console.error(`[gradle] Gradle wrapper not found: ${launcher}`);
  process.exit(1);
}

console.log(`[gradle] cd ${androidDir}`);
console.log(`[gradle] ${isWindows ? 'gradlew.bat' : './gradlew'} ${args.join(' ')}`);

const child = spawn(launcher, args, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: isWindows, // required so gradlew.bat resolves on Windows
});

child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (err) => {
  console.error(`[gradle] Failed to start Gradle: ${err.message}`);
  process.exit(1);
});
