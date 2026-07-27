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
        ensureValue(command, '--port', String(input.session.metroPort));
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
    return {
        mode: 'session',
        command,
        env: {
            RCT_METRO_PORT: String(input.session.metroPort),
            RN_DEV_AGENT_SESSION_ID: input.session.sessionId,
        },
    };
}
