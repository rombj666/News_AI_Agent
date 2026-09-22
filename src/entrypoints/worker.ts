export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return Response.json({ status: 'ok', service: 'news-ai-agent', stage: 'foundation', liveIntegrations: false });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
