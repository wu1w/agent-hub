import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const arch = args.includes('--arch') ? args[args.indexOf('--arch') + 1] : process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('Build on macOS with --arch arm64 or x64');
const nodeVersion = '22.23.3';
const nodeArchive = `node-v${nodeVersion}-darwin-${arch}.tar.gz`;
const dist = path.join(root, 'dist');
const output = path.join(dist, `macos-${arch}`);
const app = path.join(output, 'Agent Hub.app');
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const runtime = path.join(resources, 'runtime');
const exec = (cmd, params) => execFileSync(cmd, params, { cwd: root, stdio: 'inherit' });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const sha = data => createHash('sha256').update(data).digest('hex');
const cache = path.join(os.homedir(), 'Library', 'Caches', 'agent-hub-build');
await fs.mkdir(cache, { recursive: true });
const base = `https://nodejs.org/dist/v${nodeVersion}/`;
const sumsResponse = await fetch(base + 'SHASUMS256.txt');
if (!sumsResponse.ok) throw new Error(`Cannot read Node checksums: ${sumsResponse.status}`);
const checksums = await sumsResponse.text();
const expected = checksums.split('\n').find(line => line.endsWith(`  ${nodeArchive}`))?.split(/\s+/)[0];
if (!expected) throw new Error('Pinned runtime absent from official checksum manifest');
const cached = path.join(cache, nodeArchive);
let bytes = await fs.readFile(cached).catch(() => null);
if (!bytes || sha(bytes) !== expected) {
  const response = await fetch(base + nodeArchive);
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected) throw new Error('Runtime checksum mismatch');
  await fs.writeFile(cached, bytes);
}
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
const extraction = await fs.mkdtemp(path.join(cache, 'extract-'));
try {
  exec('/usr/bin/tar', ['-xzf', cached, '-C', extraction]);
  const source = path.join(extraction, `node-v${nodeVersion}-darwin-${arch}`);
  await fs.copyFile(path.join(source, 'bin/node'), path.join(runtime, 'node'));
  await fs.chmod(path.join(runtime, 'node'), 0o755);
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(resources, 'Node-LICENSE.txt'));
} finally { await fs.rm(extraction, { recursive: true, force: true }); }

await build({
  entryPoints: [path.join(root, 'desktop/backend.ts')], outfile: path.join(runtime, 'server.mjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true, sourcemap: false,
  mainFields: ['module', 'main'],
  define: { __HUB_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// Runtime assets only: no source checkout, test fixtures, node_modules or user data.
await fs.mkdir(path.join(resources, 'web'), { recursive: true });
for (const name of ['index.html', 'login.html', 'app.js', 'app.css', 'i18n.js', 'errors.js', 'vault-draft.js', 'logo.png', 'logo.jpg', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png']) {
  await fs.copyFile(path.join(root, 'web', name), path.join(resources, 'web', name));
}
for (const locale of ['en', 'zh-Hans']) {
  await fs.cp(path.join(root, 'desktop/macos', `${locale}.lproj`), path.join(resources, `${locale}.lproj`), { recursive: true });
}
let licenses = 'Agent Hub third-party JavaScript dependencies\n';
for (const name of Object.keys(pkg.dependencies)) {
  const dir = path.join(root, 'node_modules', name);
  const license = (await fs.readdir(dir)).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
  licenses += `\n=== ${name} ===\n${license ? await fs.readFile(path.join(dir, license), 'utf8') : 'See package metadata.'}\n`;
}
await fs.writeFile(path.join(resources, 'ThirdPartyNotices.txt'), licenses);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
await fs.writeFile(path.join(resources, 'build-info.json'), JSON.stringify({ version: pkg.version, sourceCommit, sourceDirty, node: nodeVersion, arch, runtimeSha256: expected }, null, 2));

const icons = path.join(output, 'AppIcon.iconset');
await fs.mkdir(icons);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) exec('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(root, 'web/logo.png'), '--out', path.join(icons, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
}
exec('/usr/bin/iconutil', ['-c', 'icns', icons, '-o', path.join(resources, 'AppIcon.icns')]);
await fs.rm(icons, { recursive: true });
await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.wu1w.agent-hub</string>
<key>CFBundleName</key><string>Agent Hub</string><key>CFBundleDisplayName</key><string>Agent Hub</string>
<key>CFBundleExecutable</key><string>AgentHub</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(pkg.version)}</string><key>CFBundleVersion</key><string>${xml(pkg.version)}</string>
<key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string></array>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`);
exec('/usr/bin/xcrun', ['swiftc', '-O', '-whole-module-optimization', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`, '-framework', 'AppKit', '-framework', 'WebKit', path.join(root, 'desktop/macos/AgentHub.swift'), '-o', path.join(contents, 'MacOS/AgentHub')]);
// Preserve Node's vendor signature. The outer bundle has an ad-hoc signature;
// Developer ID signing and notarization require an explicit future release setup.
exec('/usr/bin/codesign', ['--force', '--sign', '-', app]);
exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const stem = `Agent-Hub-${pkg.version}-macOS-${arch}`;
const zip = path.join(dist, `${stem}.zip`);
await fs.rm(zip, { force: true });
exec('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
const artifacts = [zip];
if (!args.includes('--skip-dmg')) {
  const staging = path.join(output, 'dmg');
  await fs.mkdir(staging);
  exec('/usr/bin/ditto', [app, path.join(staging, 'Agent Hub.app')]);
  await fs.symlink('/Applications', path.join(staging, 'Applications'));
  const dmg = path.join(dist, `${stem}.dmg`);
  await fs.rm(dmg, { force: true });
  exec('/usr/bin/hdiutil', ['create', '-volname', 'Agent Hub', '-srcfolder', staging, '-format', 'UDZO', dmg]);
  await fs.rm(staging, { recursive: true });
  artifacts.push(dmg);
}
await fs.writeFile(path.join(dist, `${stem}-SHA256SUMS.txt`), (await Promise.all(artifacts.map(async file => `${sha(await fs.readFile(file))}  ${path.basename(file)}`))).join('\n') + '\n');
console.log(`Built ${app}\n${artifacts.join('\n')}`);
