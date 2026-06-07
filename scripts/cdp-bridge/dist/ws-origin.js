// RN 0.85+ / @react-native/dev-middleware guards the Metro inspector proxy with
// an Origin check (WebSocket CSRF defense): handshakes whose Origin hostname is
// not loopback get a 401. Node's `ws` sends no Origin by default, so synthesize
// a loopback Origin matching the dev-server port to satisfy the allowlist
// (localhost / 127.0.0.1 / 0.0.0.0 / [::]).
export function metroOrigin(wsUrl) {
    try {
        const { port } = new URL(wsUrl);
        return `http://localhost:${port || '8081'}`;
    }
    catch {
        return 'http://localhost:8081';
    }
}
