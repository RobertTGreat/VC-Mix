import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!trackedFiles.length) throw new Error('Stage the intended public files before checking them.');

const forbiddenPaths = /(^|\/)(node_modules|build|dist|\.downloads|\.venv|\.firecrawl|__pycache__|recordings)(\/|$)|(^|\/)(\.env|routes\.json|settings\.json)$|\.(har|log|pdb|obj|pyc)$/i;
const secretPatterns = [
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{25,}\b/,
  /\bmfa\.[A-Za-z0-9_-]{60,}\b/,
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const privateValues = [];
const environmentPath = new URL('../.env', import.meta.url);
if (existsSync(environmentPath)) {
  for (const line of readFileSync(environmentPath, 'utf8').split(/\r?\n/)) {
    const match = /^DISCORD_(?:BOT_TOKEN|GUILD_ID|VOICE_CHANNEL_ID|IGNORED_USER_IDS)=(.*)$/.exec(line);
    if (!match) continue;
    const configured = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (configured.length >= 16) privateValues.push(...configured.split(/[\s,]+/).filter((entry) => entry.length >= 16));
  }
}

const findings = [];
for (const relativePath of trackedFiles) {
  if (forbiddenPaths.test(relativePath)) findings.push(`${relativePath}: private or generated path`);
  const bytes = execFileSync('git', ['show', `:${relativePath}`], { cwd: projectRoot });
  if (bytes.includes(Buffer.from(projectRoot)) || bytes.includes(Buffer.from(projectRoot.replaceAll('\\', '/')))) {
    findings.push(`${relativePath}: local workspace path`);
  }
  if (/\.(png|jpg|ico)$/i.test(relativePath)) continue;
  const contents = bytes.toString('utf8');
  if (secretPatterns.some((pattern) => pattern.test(contents)) || privateValues.some((secret) => contents.includes(secret))) {
    findings.push(`${relativePath}: possible credential or local Discord identifier`);
  }
}
if (findings.length) throw new Error(`Public source check failed:\n${findings.join('\n')}`);
console.log(`PASS: ${trackedFiles.length} intended public files contain no private paths, local configuration or detected credentials.`);
