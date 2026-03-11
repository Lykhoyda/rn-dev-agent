import { http, HttpResponse } from 'msw';

const BASE_URL = 'https://api.testapp.local';

export const handlers = [
  http.get(`${BASE_URL}/api/feed`, ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get('error') === 'true') {
      return HttpResponse.json(
        { error: 'Internal Server Error', message: 'Feed service unavailable' },
        { status: 500 },
      );
    }
    return HttpResponse.json([
      { id: '1', title: 'First Post', body: 'Hello from the test app feed' },
      { id: '2', title: 'Second Post', body: 'Testing network log capture' },
      { id: '3', title: 'Third Post', body: 'MSW mock response' },
    ]);
  }),

  http.get(`${BASE_URL}/api/user/profile`, () => {
    return HttpResponse.json({
      name: 'Test User',
      email: 'test@rndevagent.com',
      avatar: 'https://placeholders.dev/40x40',
    });
  }),

  http.post(`${BASE_URL}/api/notifications/read`, () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
