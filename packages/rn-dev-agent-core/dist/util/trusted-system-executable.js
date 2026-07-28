import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
function trustedWindowsRoots(environment) {
    return [
        ...new Set([
            environment.SystemRoot,
            environment.SYSTEMROOT,
            environment.windir,
            environment.WINDIR,
        ]
            .filter((root) => typeof root === 'string' &&
            /^[a-z]:\\/i.test(root) &&
            win32.basename(win32.normalize(root)).toLowerCase() === 'windows')
            .map((root) => win32.normalize(root))
            .concat('C:\\Windows')),
    ];
}
export function resolveTrustedSystemExecutable(executable, platform, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const environment = dependencies.environment ?? process.env;
    let candidates;
    if (platform === 'win32' && executable === 'powershell') {
        candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    }
    else if (platform === 'win32' && executable === 'taskkill') {
        candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, 'System32', 'taskkill.exe'));
    }
    else if (platform === 'linux' && executable === 'ss') {
        candidates = ['/usr/bin/ss', '/usr/sbin/ss', '/bin/ss', '/sbin/ss'];
    }
    else if (platform === 'linux' && executable === 'lsof') {
        candidates = ['/usr/bin/lsof', '/usr/sbin/lsof', '/bin/lsof', '/sbin/lsof'];
    }
    else if (platform === 'linux' && executable === 'ps') {
        candidates = ['/usr/bin/ps', '/bin/ps'];
    }
    else if (platform === 'darwin' && executable === 'lsof') {
        candidates = ['/usr/sbin/lsof'];
    }
    else if (platform === 'darwin' && executable === 'ps') {
        candidates = ['/bin/ps', '/usr/bin/ps'];
    }
    else {
        return null;
    }
    return candidates.find(exists) ?? null;
}
