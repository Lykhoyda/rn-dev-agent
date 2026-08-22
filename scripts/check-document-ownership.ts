import { readdirSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(import.meta.dirname, '..');
const rootDocs = join(repositoryRoot, 'docs');

function collectEntries(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectEntries(path) : [relative(repositoryRoot, path)];
  });
}

const misplacedDocuments = collectEntries(rootDocs).sort();

if (misplacedDocuments.length > 0) {
  console.error('Top-level docs/ is not an owned documentation surface:');
  for (const path of misplacedDocuments) console.error(`  ${path}`);
  console.error(
    'Use https://github.com/Lykhoyda/rn-dev-agent-workspace/tree/main/docs/ for engineering material, https://github.com/Lykhoyda/anton-factory/tree/main/architect-docs/ for approved architecture records, or apps/docs-site for product documentation.',
  );
  process.exitCode = 1;
} else {
  console.log('documentation ownership: ok (no top-level docs tree)');
}
