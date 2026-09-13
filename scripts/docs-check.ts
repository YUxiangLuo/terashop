import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Offline file-link check, not a Markdown/anchor validator or network crawler.
const tracked = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md']);
if (tracked.exitCode !== 0) throw new Error('Cannot enumerate repository documents');
const files = [...new Set(tracked.stdout.toString().split('\0').filter(path => path && existsSync(path)))];
const errors: string[] = []; let links = 0;
for (const file of files) {
  const source = (await Bun.file(file).text()).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
    const path = decodeURIComponent(href.split(/[?#]/)[0]);
    if (!path) continue;
    links++;
    if (!existsSync(resolve(dirname(file), path))) errors.push(`${file}: ${href}`);
  }
}
if (errors.length) {
  console.error(`Broken document links:\n${errors.join('\n')}`); process.exitCode = 1;
} else console.log(`Checked ${links} local file links in ${files.length} Markdown files (anchors and remote URLs not checked)`);
