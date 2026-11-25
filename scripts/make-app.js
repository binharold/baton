// Builds "AI Panel.app": opens with one click from the Dock / Launchpad.
// Run: npm run app   (Mac only)
const { execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
if (process.platform !== 'darwin') { console.log('This command only works on macOS.'); process.exit(1); }
const appDir = path.join(os.homedir(), 'Applications');
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(path.join(os.homedir(), '.ai-panel'), { recursive: true });
const target = path.join(appDir, 'AI Panel.app');
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// When the app is opened from Finder, PATH is restricted; we embed the current PATH (claude/codex/gemini live here).
const shell = `export PATH=${sq(process.env.PATH)}; cd ${sq(path.resolve(__dirname, '..'))}; nohup ${sq(process.execPath)} server.js >> ${sq(path.join(os.homedir(), '.ai-panel', 'panel.log'))} 2>&1 &`;
const script = `do shell script "${shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const tmp = path.join(os.tmpdir(), 'ai-panel-app.applescript');
fs.writeFileSync(tmp, script);
if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
execFileSync('osacompile', ['-o', target, tmp]);
console.log(`Ready: ${target}\nFind "AI Panel" in Finder > Applications (user) and drag it to the Dock.`);
