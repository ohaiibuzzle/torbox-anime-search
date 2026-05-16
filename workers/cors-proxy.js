const allowedOrigins = [
  "https://thisthingstreams.netlify.app",
];

const allowedApiHosts = [
  "api.torbox.app",
];

const PROXY_ENDPOINT = "/corsproxy/";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");

    if (!origin || !allowedOrigins.includes(origin)) {
      return new Response("Origin not allowed", { status: 403, statusText: "Forbidden" });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Max-Age": "86400",
    };

    const url = new URL(request.url);
    if (!url.pathname.startsWith(PROXY_ENDPOINT)) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }

    if (request.method === "OPTIONS") {
      if (
        request.headers.get("Access-Control-Request-Method") !== null &&
        request.headers.get("Access-Control-Request-Headers") !== null
      ) {
        return new Response(null, {
          headers: {
            ...corsHeaders,
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers"),
          },
        });
      }
      return new Response(null, { headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
    }

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return new Response(null, { status: 405, statusText: "Method Not Allowed" });
    }

    const apiUrlParam = url.searchParams.get("apiurl");
    if (!apiUrlParam) {
      return new Response("Missing 'apiurl' query parameter", { status: 400, statusText: "Bad Request" });
    }

    let parsedApiUrl;
    try {
      parsedApiUrl = new URL(apiUrlParam);
    } catch {
      return new Response("Invalid 'apiurl' parameter", { status: 400, statusText: "Bad Request" });
    }

    if (!allowedApiHosts.includes(parsedApiUrl.hostname)) {
      return new Response("API host not allowed", { status: 403, statusText: "Forbidden" });
    }

    request = new Request(parsedApiUrl.href, request);
    request.headers.set("Origin", parsedApiUrl.origin);
    let response = await fetch(request);
    response = new Response(response.body, response);
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.append("Vary", "Origin");
    return response;
  },
};
