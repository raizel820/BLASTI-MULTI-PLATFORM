#!/usr/bin/env node
/**
 * Cross-platform Gradle wrapper runner.
 *
 * `./gradlew` (POSIX shell script) does not exist as an executable on
 * Windows — it needs `gradlew.bat`. This helper picks the right launcher
 * for the current OS so npm/bun scripts stay identical on Linux and
 * Windows:
 *
 *   node scripts/gradle.js assembleDebug
 *   node scripts/gradle.js assembleRelease
 *
 * Always targets apps/mobile/android regardless of the caller's CWD.
 *
 * Task 52 additions (so `bun run mobile:apk` works from a plain terminal,
 * without opening Android Studio first):
 *   • Auto-detects JAVA_HOME (Android Studio's bundled JBR → system JDKs)
 *   • Auto-detects the Android SDK and writes local.properties if missing
 *   • On success, copies the APK to the repo root as
 *       BLASTI-v<versionName>-<variant>.apk
 *     and prints the full path + install instructions.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..');
const androidDir = path.join(ROOT, 'apps', 'mobile', 'android');
const isWindows = process.platform === 'win32';

function log(msg) { console.log(`[gradle] ${msg}`); }
function warn(msg) { console.warn(`[gradle] ${msg}`); }
function die(msg) {
  console.error(`[gradle] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(androidDir)) {
  die(`Android project directory not found: ${androidDir}`);
}

const launcher = isWindows ? 'gradlew.bat' : path.join(androidDir, 'gradlew');
if (!fs.existsSync(isWindows ? path.join(androidDir, 'gradlew.bat') : launcher)) {
  die(`Gradle wrapper not found: ${launcher}`);
}

// ─── Java (JAVA_HOME) detection ──────────────────────────────────────────────
// Gradle needs a JDK. Android Studio ships a private one (jbr) — prefer it so
// users who installed Android Studio never have to configure anything.

function isJavaHome(dir) {
  if (!dir) return false;
  try {
    const bin = path.join(dir, 'bin');
    return fs.existsSync(path.join(bin, isWindows ? 'java.exe' : 'java'));
  } catch { return false; }
}

function listDirs(base, prefix) {
  try {
    return fs.readdirSync(base)
      .filter((d) => d.startsWith(prefix))
      .sort()
      .reverse() // prefer the highest version
      .map((d) => path.join(base, d));
  } catch { return []; }
}

function detectJavaHome() {
  if (isJavaHome(process.env.JAVA_HOME)) {
    log(`Using JAVA_HOME from environment: ${process.env.JAVA_HOME}`);
    return process.env.JAVA_HOME;
  }

  const candidates = [];
  if (isWindows) {
    candidates.push(
      'C:\\Program Files\\Android\\Android Studio\\jbr',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
      'C:\\Program Files\\Android\\Android Studio Preview\\jbr'
    );
    candidates.push(...listDirs('C:\\Program Files\\Java', 'jdk'));
    candidates.push(...listDirs('C:\\Program Files\\Eclipse Adoptium', 'jdk'));
    candidates.push(...listDirs('C:\\Program Files\\Microsoft', 'jdk'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    candidates.push(...listDirs('/Library/Java/JavaVirtualMachines', 'jdk')
      .map((d) => path.join(d, 'Contents', 'Home')));
  } else {
    candidates.push(...listDirs('/usr/lib/jvm', 'android-studio'));
    candidates.push(...listDirs('/usr/lib/jvm', 'java-'));
  }

  const found = candidates.find((c) => c && isJavaHome(c));
  if (!found) return null;
  log(`Detected Java at: ${found}`);
  return found;
}

// ─── Android SDK detection (+ local.properties) ──────────────────────────────

function looksLikeSdk(dir) {
  if (!dir) return false;
  try {
    return ['platform-tools', 'platforms', 'build-tools'].some(
      (sub) => fs.existsSync(path.join(dir, sub))
    );
  } catch { return false; }
}

function detectSdkDir() {
  const localProps = path.join(androidDir, 'local.properties');
  if (fs.existsSync(localProps)) {
    // Already configured (Android Studio writes this file) — trust it.
    const content = fs.readFileSync(localProps, 'utf8');
    const m = content.match(/sdk\.dir\s*=\s*(.+)/);
    if (m) {
      log(`Using SDK from local.properties: ${m[1].trim()}`);
      return m[1].trim().replace(/\\\\/g, '\\');
    }
  }

  if (looksLikeSdk(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  if (looksLikeSdk(process.env.ANDROID_SDK_ROOT)) return process.env.ANDROID_SDK_ROOT;

  const candidates = [];
  if (isWindows) {
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'));
    candidates.push(path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Android', 'Sdk'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  } else {
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  }

  return candidates.find((c) => c && looksLikeSdk(c)) || null;
}

function ensureSdk() {
  const sdk = detectSdkDir();
  if (!sdk) {
    die(
      'Android SDK not found.\n' +
      '  Install Android Studio (https://developer.android.com/studio) — it bundles the SDK —\n' +
      '  or set the ANDROID_HOME environment variable to your SDK folder\n' +
      '  (default Windows location: %LOCALAPPDATA%\\Android\\Sdk).'
    );
  }
  if (!looksLikeSdk(process.env.ANDROID_HOME) && !looksLikeSdk(process.env.ANDROID_SDK_ROOT)) {
    // Persist the location so Gradle/Android Studio both agree on it.
    const localProps = path.join(androidDir, 'local.properties');
    if (!fs.existsSync(localProps)) {
      const escaped = sdk.replace(/\\/g, '/');
      fs.writeFileSync(localProps, `sdk.dir=${escaped}\n`);
      log(`Wrote ${localProps} (sdk.dir=${escaped})`);
    }
  }
  return sdk;
}

// ─── APK reporting ───────────────────────────────────────────────────────────

function readVersionName() {
  try {
    const gradle = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle'), 'utf8');
    const m = gradle.match(/versionName\s+"([^"]+)"/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return '1.0.0';
}

function findApks(dir, out) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findApks(full, out);
      else if (entry.name.endsWith('.apk')) out.push(full);
    }
  } catch { /* output dir may not exist */ }
  return out;
}

function reportVariant(variant, version) {
  const outDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', variant);
  const apks = findApks(outDir, []);
  if (apks.length === 0) {
    warn(`Build succeeded but no ${variant} APK was found under ${outDir}`);
    return;
  }
  // Newest (largest mtime) wins — Gradle may keep multiple outputs.
  const apk = apks.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

  let finalPath = apk;
  try {
    const friendly = path.join(ROOT, `BLASTI-v${version}-${variant}.apk`);
    fs.copyFileSync(apk, friendly);
    finalPath = friendly;
  } catch (err) {
    warn(`Could not copy APK to the repo root (${err.message}) — using the original path.`);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  ✅ BLASTI ${variant.toUpperCase()} APK built successfully!`);
  console.log('');
  console.log(`  ${finalPath}`);
  console.log('');
  if (variant === 'release') {
    console.log('  ⚠️  This RELEASE APK is UNSIGNED (no keystore configured) —');
    console.log('     Android will refuse to install it. Use the debug APK');
    console.log('     (`bun run mobile:apk:debug`) for on-device testing, or add');
    console.log('     a signingConfig to apps/mobile/android/app/build.gradle.');
  } else {
    console.log('  Install it on your phone — pick one:');
    console.log('    1. Copy the APK file to your phone (USB / cloud / chat)');
    console.log('       and tap it (allow "install unknown apps" if asked).');
    console.log('    2. USB debugging connected:  adb install -r "<path>"');
  }
  console.log('');
  console.log('  TIP: uninstall the old BLASTI from the phone first if it');
  console.log('  crashes on launch (signature mismatch between builds).');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
}

function reportApk() {
  // One invocation may request both tasks (assembleDebug assembleRelease) —
  // report every variant that was actually built.
  const variants = [];
  if (args.includes('assembleDebug')) variants.push('debug');
  if (args.includes('assembleRelease')) variants.push('release');
  if (variants.length === 0) variants.push('debug'); // assembleDefault safety net

  const version = readVersionName();
  for (const variant of variants) reportVariant(variant, version);
}

// ─── Run Gradle ──────────────────────────────────────────────────────────────

const javaHome = detectJavaHome();
if (!javaHome) {
  die(
    'No JDK found.\n' +
    '  Install Android Studio (its bundled Java is detected automatically)\n' +
    '  or install a JDK 17+ and set JAVA_HOME.'
  );
}
ensureSdk();

console.log(`[gradle] cd ${androidDir}`);
console.log(`[gradle] ${isWindows ? 'gradlew.bat' : './gradlew'} ${args.join(' ')}`);

// Windows requires shell:true so gradlew.bat resolves. Node warns (DEP0190)
// when an args ARRAY is combined with shell:true, so on Windows we join the
// command into a single string ourselves. The pieces are trusted inputs
// (the constant launcher name and gradle task names — no spaces, no user
// input), so the "unescaped arguments" concern does not apply.
const child = spawn(
  isWindows ? [launcher, ...args].join(' ') : launcher,
  isWindows ? [] : args,
  {
    cwd: androidDir,
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      // Make sure Gradle uses THIS Java even if another JDK is first on PATH.
      PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    },
  }
);

child.on('exit', (code) => {
  if (code === 0 && args.some((a) => typeof a === 'string' && a.startsWith('assemble'))) {
    reportApk();
  }
  process.exit(code === null ? 1 : code);
});
child.on('error', (err) => {
  console.error(`[gradle] Failed to start Gradle: ${err.message}`);
  process.exit(1);
});
