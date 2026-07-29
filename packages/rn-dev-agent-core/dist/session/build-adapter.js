function conflict(flag) {
    throw new Error(`SESSION_BUILD_IDENTITY_CONFLICT: ${flag} contradicts the active session`);
}
function ensureValue(command, flag, value) {
    const index = command.indexOf(flag);
    if (index >= 0) {
        if (command[index + 1] !== value)
            conflict(flag);
        return;
    }
    command.push(flag, value);
}
function ensureFlag(command, flag) {
    if (!command.includes(flag))
        command.push(flag);
}
function removeValue(command, flag, value) {
    for (let index = command.indexOf(flag); index >= 0; index = command.indexOf(flag)) {
        if (command[index + 1] !== value)
            conflict(flag);
        command.splice(index, 2);
    }
}
function managedMetroProxyUrl(session) {
    if (session.platform === 'ios') {
        return `http://127.0.0.1:${session.metroPort}`;
    }
    if (/^emulator-\d+$/.test(session.deviceId)) {
        return `http://10.0.2.2:${session.metroPort}`;
    }
    if (!session.devClientUrl) {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: physical Android session requires an exact Dev Client URL');
    }
    let metroUrl;
    try {
        const encodedMetroUrl = new URL(session.devClientUrl).searchParams.get('url');
        if (!encodedMetroUrl)
            throw new Error('missing url parameter');
        metroUrl = new URL(encodedMetroUrl);
    }
    catch {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: Dev Client URL does not contain an exact managed Metro endpoint');
    }
    if (!['http:', 'https:'].includes(metroUrl.protocol) ||
        Number(metroUrl.port) !== session.metroPort) {
        throw new Error('SESSION_BUILD_IDENTITY_CONFLICT: Dev Client URL contradicts the active managed Metro');
    }
    return metroUrl.origin;
}
function commandKind(command) {
    const offset = command[0] === 'npx' ? 1 : 0;
    const executable = command[offset];
    const subcommand = command[offset + 1];
    if (executable === 'expo' && (subcommand === 'run:ios' || subcommand === 'run:android')) {
        return 'expo';
    }
    if (executable === 'react-native' && subcommand === 'run-ios')
        return 'bare-ios';
    if (executable === 'react-native' && subcommand === 'run-android')
        return 'bare-android';
    return null;
}
export function createBuildLaunchPlan(input) {
    const command = [...input.command];
    if (!input.session)
        return { mode: 'passthrough', command, env: {} };
    if (input.session.platform !== input.platform)
        conflict('platform');
    const kind = commandKind(command);
    const expectedKind = input.platform === 'ios' ? new Set(['expo', 'bare-ios']) : new Set(['expo', 'bare-android']);
    if (!kind || !expectedKind.has(kind)) {
        throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: command shape is not recognized');
    }
    if (kind === 'expo') {
        ensureValue(command, '--device', input.session.deviceId);
        removeValue(command, '--port', String(input.session.metroPort));
        ensureFlag(command, '--no-bundler');
    }
    else if (kind === 'bare-ios') {
        ensureValue(command, '--udid', input.session.deviceId);
        ensureValue(command, '--port', String(input.session.metroPort));
        ensureFlag(command, '--no-packager');
    }
    else {
        ensureValue(command, '--deviceId', input.session.deviceId);
        ensureValue(command, '--port', String(input.session.metroPort));
        ensureFlag(command, '--no-packager');
    }
    const env = {
        ORG_GRADLE_PROJECT_reactNativeDevServerPort: String(input.session.metroPort),
        RCT_METRO_PORT: String(input.session.metroPort),
        RN_DEV_AGENT_SESSION_ID: input.session.sessionId,
        ...(kind === 'expo' ? { EXPO_PACKAGER_PROXY_URL: managedMetroProxyUrl(input.session) } : {}),
    };
    return {
        mode: 'session',
        command,
        env,
    };
}
