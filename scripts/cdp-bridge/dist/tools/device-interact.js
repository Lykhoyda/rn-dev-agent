import { runAgentDevice } from '../agent-device-wrapper.js';
import { withSession } from '../utils.js';
export function createDeviceFindHandler() {
    return withSession((args) => {
        const cliArgs = ['find', args.text];
        if (args.action)
            cliArgs.push(args.action);
        return runAgentDevice(cliArgs);
    });
}
export function createDevicePressHandler() {
    return withSession((args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        return runAgentDevice(['press', ref]);
    });
}
export function createDeviceFillHandler() {
    return withSession((args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        return runAgentDevice(['fill', ref, args.text]);
    });
}
export function createDeviceSwipeHandler() {
    return withSession((args) => runAgentDevice(['swipe', args.direction]));
}
export function createDeviceBackHandler() {
    return withSession(() => runAgentDevice(['back']));
}
