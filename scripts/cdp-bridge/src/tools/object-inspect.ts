import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

interface PropertyDescriptor {
  name: string;
  value?: { type: string; value?: unknown; description?: string; objectId?: string; className?: string; subtype?: string };
  get?: { type: string };
  set?: { type: string };
  configurable?: boolean;
  enumerable?: boolean;
  isOwn?: boolean;
}

export function createObjectInspectHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { expression: string; depth?: number; maxProperties?: number }, client) => {
    const depth = Math.min(Math.max(args.depth ?? 1, 0), 3);
    const maxProps = Math.min(Math.max(args.maxProperties ?? 20, 1), 100);

    try {
      const evalResult = await client.send('Runtime.evaluate', {
        expression: args.expression,
        returnByValue: false,
        generatePreview: true,
        objectGroup: 'rn-agent-inspect',
      }) as {
        result?: { type: string; objectId?: string; value?: unknown; description?: string; className?: string; subtype?: string; preview?: unknown };
        exceptionDetails?: { text: string };
      };

      if (evalResult.exceptionDetails) {
        return failResult(`Expression threw: ${evalResult.exceptionDetails.text}`);
      }

      const obj = evalResult.result;
      if (!obj) return failResult('No result from expression');

      if (!obj.objectId) {
        return okResult({
          type: obj.type,
          value: obj.value,
          description: obj.description,
          primitive: true,
        });
      }

      const inspected = await inspectObject(client, obj.objectId, depth, maxProps);

      try {
        await client.send('Runtime.releaseObjectGroup', { objectGroup: 'rn-agent-inspect' });
      } catch { /* best effort cleanup */ }

      return okResult({
        type: obj.type,
        className: obj.className,
        description: obj.description,
        primitive: false,
        properties: inspected,
      });
    } catch (err) {
      try {
        await client.send('Runtime.releaseObjectGroup', { objectGroup: 'rn-agent-inspect' });
      } catch { /* cleanup */ }
      return failResult(`Inspect failed: ${err instanceof Error ? err.message : err}`);
    }
  });
}

async function inspectObject(
  client: CDPClient,
  objectId: string,
  depth: number,
  maxProps: number,
): Promise<Array<{ name: string; type: string; value?: unknown; description?: string; hasChildren?: boolean }>> {
  const result = await client.send('Runtime.getProperties', {
    objectId,
    ownProperties: true,
    generatePreview: true,
  }) as { result?: PropertyDescriptor[] };

  const props = (result.result ?? [])
    .filter(p => p.isOwn !== false)
    .slice(0, maxProps);

  type Entry = { name: string; type: string; value?: unknown; description?: string; hasChildren?: boolean; children?: unknown };
  const results: Entry[] = [];
  // Fetch sibling children concurrently instead of one serial CDP round-trip at
  // a time. Entries are pushed synchronously so order is preserved; only the
  // recursive getProperties calls are parallelized.
  const childFetches: Array<Promise<void>> = [];

  for (const p of props) {
    const v = p.value;
    if (!v) { results.push({ name: p.name, type: 'accessor', description: '[getter/setter]' }); continue; }

    const entry: Entry = {
      name: p.name,
      type: v.type,
      description: v.description ?? (v.value !== undefined ? String(v.value) : undefined),
    };

    if (v.type === 'object' && v.objectId && v.subtype !== 'null') {
      entry.hasChildren = true;
      entry.description = v.className ?? v.description ?? '[object]';
      if (depth > 0) {
        const objectId = v.objectId;
        childFetches.push(
          inspectObject(client, objectId, depth - 1, maxProps).then((c) => { entry.children = c; }),
        );
      }
    } else {
      entry.value = v.value;
    }

    results.push(entry);
  }

  await Promise.all(childFetches);
  return results;
}
