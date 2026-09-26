import type { NativePresence } from './native-presence.js';
import type { NativeNode, ReactHostEvidence } from './screen.js';
import type { HostTypography } from './host-typography.js';

type Rect = NonNullable<NativeNode['rect']>;
export type HostAssociation = { nativeIndex: number; anchorIndex: number };

export function hostPath(snapshot: HostTypography, start: number): number[] | undefined {
  const path: number[] = [];
  let current: number | null = start;
  while (current !== null) {
    if (path.includes(current) || !snapshot.nodes[current]) return undefined;
    path.push(current);
    current = snapshot.nodes[current].parentHostIndex;
  }
  return path;
}

function nativePath(nodes: NativeNode[], start: number): number[] {
  const path: number[] = [];
  let current: number | undefined = start;
  while (current !== undefined && nodes[current] && !path.includes(current)) {
    path.push(current);
    current = nodes[current].parentIndex;
  }
  return path;
}

function compatible(host: string | null, native: string | undefined): boolean {
  if (host === 'RCTText' || host === 'Text') return native === 'StaticText';
  if (host === 'RCTView' || host === 'View')
    return native === 'Other' || native === 'Button' || native === 'Cell';
  if (host === 'RCTScrollView' || host === 'ScrollView') return native === 'ScrollView';
  return false;
}

function sameFrame(host: Rect | undefined, native: Rect | undefined, window: Rect): boolean {
  return (
    !!host &&
    !!native &&
    host.x + window.x === native.x &&
    host.y + window.y === native.y &&
    host.width === native.width &&
    host.height === native.height
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function possibleTextOwner(host: HostTypography['nodes'][number], content: string): boolean {
  const accessibility = host.accessibility;
  if (
    (!accessibility && host.hostType !== 'RCTVirtualText') ||
    accessibility?.accessible === 'true' ||
    accessibility?.accessible === 'unknown' ||
    accessibility?.authoredLabel === 'present' ||
    accessibility?.authoredLabel === 'unknown'
  )
    return true;
  switch (host.text.kind) {
    case 'block':
      return host.text.content === content;
    case 'inline':
      return host.hostType !== 'RCTVirtualText';
    case 'none':
      // A generic host type cannot rule out native accessibility text traits.
      return true;
    case 'unsupported':
      return true;
  }
}

export function associateHosts(
  nodes: NativeNode[],
  evidence: ReactHostEvidence | undefined,
  presence: NativePresence | undefined,
): Map<number, HostAssociation> {
  const associations = new Map<number, HostAssociation>();
  const snapshot = evidence?.typography;
  if (!evidence?.complete || !snapshot?.complete || !presence) return associations;
  const windows = nodes.flatMap((node, i) => (node.type === 'Window' ? [i] : []));
  if (windows.length !== 1) return associations;
  const windowIndex = windows[0];
  const window = nodes[windowIndex].rect;
  if (
    !window ||
    !Object.values(window).every(Number.isFinite) ||
    window.width <= 0 ||
    window.height <= 0
  )
    return associations;
  const paths = snapshot.nodes.map((node) => hostPath(snapshot, node.hostIndex)!);
  const nativePaths = nodes.map((_, i) => nativePath(nodes, i));
  const positive = (i: number) =>
    presence.nodes[i]?.status === 'observed' &&
    nativePaths[i].includes(windowIndex) &&
    typeof nodes[i].ref === 'string' &&
    !!nodes[i].ref.trim() &&
    nodes.filter((node) => node.ref === nodes[i].ref).length === 1;
  const inline = (i: number) =>
    snapshot.nodes[i].hostType === 'RCTVirtualText' && snapshot.nodes[i].text.kind === 'inline';
  const anchors = new Map<number, number>();
  for (const host of snapshot.nodes) {
    if (inline(host.hostIndex)) continue;
    const id = evidence.hosts[host.hostIndex].testID;
    if (!id || evidence.hosts.filter((h) => h.testID === id).length !== 1) continue;
    const matches = nodes.flatMap((node, i) => (node.identifier === id ? [i] : []));
    if (matches.length !== 1) continue;
    const nativeIndex = matches[0];
    if (
      positive(nativeIndex) &&
      compatible(host.hostType, nodes[nativeIndex].type) &&
      sameFrame(host.rect, nodes[nativeIndex].rect, window)
    )
      anchors.set(host.hostIndex, nativeIndex);
  }
  const anchoredPath = (i: number): boolean => {
    const named = paths[i].filter((p) => !inline(p) && !!evidence.hosts[p].testID);
    return named.every((p, n) => {
      const nativeIndex = anchors.get(p);
      const parentIndex = n + 1 < named.length ? anchors.get(named[n + 1]) : undefined;
      return (
        nativeIndex !== undefined &&
        (n + 1 === named.length ||
          (parentIndex !== undefined &&
            nativeIndex !== parentIndex &&
            nativePaths[nativeIndex].includes(parentIndex)))
      );
    });
  };
  for (const host of snapshot.nodes) {
    if (!anchoredPath(host.hostIndex)) continue;
    const direct = anchors.get(host.hostIndex);
    if (direct !== undefined) {
      associations.set(host.hostIndex, { nativeIndex: direct, anchorIndex: direct });
      continue;
    }
    if (
      host.text.kind !== 'block' ||
      !host.text.content.trim() ||
      !host.rect ||
      !compatible(host.hostType, 'StaticText')
    )
      continue;
    const anchorHost = paths[host.hostIndex].slice(1).find((i) => anchors.has(i));
    if (anchorHost === undefined) continue;
    const anchorIndex = anchors.get(anchorHost)!;
    const ancestors = paths[host.hostIndex].slice(1).map((i) => snapshot.nodes[i]);
    if (
      ancestors.some(
        (h) =>
          h.text.kind === 'unsupported' ||
          h.hostType === null ||
          (['RCTText', 'Text', 'RCTVirtualText'].includes(h.hostType) && h.text.kind === 'none'),
      ) ||
      !contains(snapshot.nodes[anchorHost].rect!, host.rect)
    )
      continue;
    const content = host.text.content;
    const matches = nodes.flatMap((node, i) =>
      i !== anchorIndex &&
      nativePaths[i].includes(anchorIndex) &&
      node.type === 'StaticText' &&
      node.label === content &&
      sameFrame(host.rect, node.rect, window)
        ? [i]
        : [],
    );
    if (
      matches.length !== 1 ||
      !!nodes[matches[0]].identifier ||
      !positive(matches[0]) ||
      presence.nodes[matches[0]].labelSource !== 'direct'
    )
      continue;
    const owners = snapshot.nodes.filter((h) => {
      const identified = anchors.get(h.hostIndex);
      if (identified !== undefined && identified !== matches[0] && anchoredPath(h.hostIndex))
        return false;
      return (
        possibleTextOwner(h, content) &&
        (!h.rect || sameFrame(h.rect, nodes[matches[0]].rect, window))
      );
    });
    if (owners.length !== 1) continue;
    associations.set(host.hostIndex, { nativeIndex: matches[0], anchorIndex });
  }
  const admitted = [...associations.values()];
  for (const [hostIndex, association] of associations) {
    if (
      admitted.some(
        (other) => other !== association && other.nativeIndex === association.nativeIndex,
      )
    )
      associations.delete(hostIndex);
  }
  return associations;
}
