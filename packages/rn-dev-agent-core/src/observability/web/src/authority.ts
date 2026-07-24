declare global {
  interface Window {
    __RN_OBSERVE_AUTHORITY__?: { capability: string; instanceId: string };
  }
}

function authority(): { capability: string; instanceId: string } {
  const value = window.__RN_OBSERVE_AUTHORITY__;
  if (!value?.capability || !value.instanceId) {
    throw new Error('Observe authority bootstrap is unavailable');
  }
  return value;
}

export function observeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const value = authority();
  return fetch(input, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${value.capability}`,
      'x-rn-observe-instance': value.instanceId,
    },
  });
}

export function observeUrl(path: string): string {
  const value = authority();
  const url = new URL(path, window.location.origin);
  url.searchParams.set('instance', value.instanceId);
  url.searchParams.set('capability', value.capability);
  return `${url.pathname}${url.search}`;
}
