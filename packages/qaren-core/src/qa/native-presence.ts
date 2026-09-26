import { isRecord } from './questions.js';
import type { NativeNode } from './screen.js';

export const PRESENCE_BUDGET_MS = 5_000;

export interface NativePresenceNode {
  status: 'observed' | 'unknown';
  labelSource: 'direct' | 'value' | 'descendant' | 'none';
}

export interface NativePresence {
  source: 'xcui-live';
  nodes: NativePresenceNode[];
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateNativePresence(
  capture: unknown,
  nodes: NativeNode[],
  generation: unknown,
  expectedAppId: string | undefined,
): NativePresence | undefined {
  if (
    !isRecord(capture) ||
    capture.version !== 1 ||
    capture.source !== 'xcui-live' ||
    capture.enumeration !== 'raw-unfiltered' ||
    capture.complete !== true ||
    !expectedAppId ||
    capture.appId !== expectedAppId ||
    typeof capture.captureId !== 'string' ||
    !capture.captureId ||
    capture.captureId.length > 128 ||
    !Number.isSafeInteger(generation) ||
    typeof generation !== 'number' ||
    generation < 1 ||
    capture.generation !== generation ||
    !finite(capture.startedUptimeMs) ||
    capture.startedUptimeMs < 0 ||
    !finite(capture.endedUptimeMs) ||
    capture.endedUptimeMs < capture.startedUptimeMs ||
    capture.endedUptimeMs - capture.startedUptimeMs >= PRESENCE_BUDGET_MS ||
    nodes.length === 0 ||
    nodes.length > 600 ||
    nodes[0].type !== 'Application' ||
    nodes[0].depth !== 0 ||
    nodes[0].parentIndex !== undefined ||
    new Set(nodes.map((node) => node.ref)).size !== nodes.length
  )
    return undefined;
  const observations: NativePresenceNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const p = node.presence;
    const parent = node.parentIndex;
    if (
      node.index !== index ||
      typeof node.type !== 'string' ||
      !node.type ||
      typeof node.enabled !== 'boolean' ||
      (index > 0 &&
        (parent === undefined ||
          !Number.isSafeInteger(parent) ||
          parent < 0 ||
          parent >= index ||
          node.depth !== nodes[parent].depth! + 1)) ||
      !node.rect ||
      !Object.values(node.rect).every(finite) ||
      !finite(node.rect.x) ||
      !finite(node.rect.y) ||
      !finite(node.rect.width) ||
      !finite(node.rect.height) ||
      node.rect.width < 0 ||
      node.rect.height < 0 ||
      !isRecord(p) ||
      p.captureId !== capture.captureId ||
      p.generation !== generation ||
      p.nodeIndex !== index ||
      (p.status !== 'observed' && p.status !== 'unknown') ||
      (p.labelSource !== 'direct' &&
        p.labelSource !== 'value' &&
        p.labelSource !== 'descendant' &&
        p.labelSource !== 'none') ||
      (p.status === 'observed' &&
        (!finite(p.observedUptimeMs) ||
          p.observedUptimeMs < capture.startedUptimeMs ||
          p.observedUptimeMs > capture.endedUptimeMs ||
          node.rect.width === 0 ||
          node.rect.height === 0)) ||
      (p.status === 'unknown' && p.observedUptimeMs !== undefined)
    )
      return undefined;
    observations.push({ status: p.status, labelSource: p.labelSource });
  }
  return { source: 'xcui-live', nodes: observations };
}
