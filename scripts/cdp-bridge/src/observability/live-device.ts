// src/observability/live-device.ts
import { classifyFamily } from './events.js';

/**
 * GH #206: which tools change on-screen state and so should trigger a live
 * /observe refresh. Single source of truth, derived from events.ts families —
 * all INTERACTION-family tools plus cdp_navigate. Read-only NAVIGATION tools
 * (cdp_navigation_state, cdp_nav_graph) are excluded: reads change nothing.
 */
export function isStateMutating(tool: string): boolean {
  return classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate';
}
