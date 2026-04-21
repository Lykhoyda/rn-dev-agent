import type { CDPClient } from '../cdp-client.js';
import { okResult, withConnection } from '../utils.js';

/**
 * cdp_metro_events — M5 / Phase 90 Tier 2.
 *
 * Read recent Metro reporter events (bundle_build_started, bundle_build_done,
 * bundle_build_failed, ...) captured by the MetroEventsClient that attaches
 * alongside every CDP session. Supports filtering by event type and clearing
 * the build-error counter.
 */
export function createMetroEventsHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: {
    limit?: number;
    type?: string;
    clearErrors?: boolean;
  }, client) => {
    const metroEvents = client.metroEventsClient;
    if (!metroEvents) {
      return okResult({
        eventsConnected: false,
        events: [],
        count: 0,
        lastBuild: null,
        buildErrors: 0,
        hint: 'Metro events client has not started. This should attach automatically when CDP connects. If you see this, the events WS may have failed to open (port mismatch, Metro not serving /events on this version).',
      });
    }

    // B129 (D658): if the endpoint was detected as incompatible during probe,
    // surface that instead of silently returning empty events forever.
    if (metroEvents.incompatibleReason === 'expo-cli-incompatible') {
      return okResult({
        eventsConnected: false,
        eventsReason: 'expo-cli-incompatible',
        lastBuild: null,
        buildErrors: 0,
        count: 0,
        events: [],
        hint: 'Metro /events endpoint is serving the Expo manifest protocol, not Metro\'s reporter stream. This is expected on Expo-managed projects — bundler events are not currently observable via this path. Workaround: watch cdp_console_log for reload/error messages, or use bare Metro (`npx react-native start`) if you need the reporter stream.',
      });
    }

    if (args.clearErrors) {
      metroEvents.clearBuildErrors();
      return okResult({
        eventsConnected: metroEvents.isConnected,
        cleared: true,
        lastBuild: metroEvents.lastBuild,
        buildErrors: metroEvents.buildErrors,
      });
    }

    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    let entries = metroEvents.events.getLast(metroEvents.events.size);

    if (args.type) {
      entries = entries.filter((e) => e.type === args.type);
    }

    if (entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return okResult({
      eventsConnected: metroEvents.isConnected,
      lastBuild: metroEvents.lastBuild,
      buildErrors: metroEvents.buildErrors,
      count: entries.length,
      events: entries,
    });
  });
}
