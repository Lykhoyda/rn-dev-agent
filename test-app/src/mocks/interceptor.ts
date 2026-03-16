const BASE_URL = 'https://api.testapp.local';

interface MockRoute {
  method: string;
  pattern: RegExp;
  handler: (url: URL) => { status: number; body: unknown };
}

const routes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /\/api\/feed$/,
    handler: (url) => {
      if (url.searchParams.get('error') === 'true') {
        return { status: 500, body: { error: 'Internal Server Error', message: 'Feed service unavailable' } };
      }
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = parseInt(url.searchParams.get('limit') ?? '5', 10);
      const allItems = Array.from({ length: 20 }, (_, i) => ({
        id: String(i + 1),
        author: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'][i % 5],
        title: `Post #${i + 1}`,
        body: `This is the body of post number ${i + 1}. It has some interesting content.`,
        avatar: `https://i.pravatar.cc/40?u=user${i % 5}`,
      }));
      const start = (page - 1) * limit;
      const items = allItems.slice(start, start + limit);
      const hasMore = start + limit < allItems.length;
      return {
        status: 200,
        body: { items, nextPage: hasMore ? page + 1 : null, hasMore },
      };
    },
  },
  {
    method: 'GET',
    pattern: /\/api\/user\/profile$/,
    handler: () => ({
      status: 200,
      body: { name: 'Test User', email: 'test@rndevagent.com', avatar: 'https://placeholders.dev/40x40' },
    }),
  },
  {
    method: 'POST',
    pattern: /\/api\/user\/profile$/,
    handler: () => ({ status: 200, body: { success: true } }),
  },
  {
    method: 'POST',
    pattern: /\/api\/notifications\/read$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    method: 'POST',
    pattern: /\/api\/notifications\/[^/]+\/read$/,
    handler: () => ({ status: 204, body: null }),
  },
  {
    method: 'POST',
    pattern: /\/api\/tasks\/sync$/,
    handler: () => ({ status: 200, body: { synced: true } }),
  },
  {
    method: 'GET',
    pattern: /\/api\/sync$/,
    handler: () => ({ status: 200, body: { synced: true } }),
  },
];

const originalFetch = globalThis.fetch;

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  if (!url.startsWith(BASE_URL)) {
    return originalFetch(input, init);
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  const parsed = new URL(url);

  for (const route of routes) {
    if (route.method === method && route.pattern.test(parsed.pathname)) {
      const { status, body } = route.handler(parsed);
      const responseBody = body !== null ? JSON.stringify(body) : '';
      return Promise.resolve(
        new Response(responseBody, {
          status,
          headers: body !== null ? { 'Content-Type': 'application/json' } : {},
        }),
      );
    }
  }

  return Promise.resolve(new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }));
}

export function enableMockFetch(): void {
  globalThis.fetch = mockFetch as typeof globalThis.fetch;
}
