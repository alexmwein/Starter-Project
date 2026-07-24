import vinext from "vinext/server/fetch-handler";

const OVO_LABS_ROOT = "/ovo-labs";
const OVO_LABS_NOT_FOUND = `${OVO_LABS_ROOT}/404`;
const LEGACY_ROOTS = ["/datum-peptides", "/third-standard"];
const LEGACY_ROUTE_ALIASES = new Map([
  ["/access", "/catalog"],
  ["/eligibility", "/policies"],
  ["/index", "/"],
  ["/lot-record", "/testing"],
]);

function redirectToOVOLabsRoot(request) {
  const url = new URL(request.url);
  url.pathname = `${OVO_LABS_ROOT}/`;
  return Response.redirect(url, 308);
}

function redirectLegacyOVOPath(request, legacyRoot) {
  const url = new URL(request.url);
  const legacyPath = url.pathname.slice(legacyRoot.length).replace(/\.html$/, "") || "/";
  const destination = LEGACY_ROUTE_ALIASES.get(legacyPath) ?? legacyPath;

  url.pathname = destination === "/" ? `${OVO_LABS_ROOT}/` : `${OVO_LABS_ROOT}${destination}`;
  return Response.redirect(url, 308);
}

function withOVOLabsHeaders(response, pathname) {
  const headers = new Headers(response.headers);

  if (pathname.endsWith(".webp")) headers.set("Content-Type", "image/webp");
  if (pathname.endsWith(".woff2")) headers.set("Content-Type", "font/woff2");

  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function renderOVOLabsNotFound(request, env) {
  const notFoundUrl = new URL(OVO_LABS_NOT_FOUND, request.url);
  const assetRequest = new Request(notFoundUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: request.headers,
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(assetResponse.headers);

  headers.set("Cache-Control", "public, max-age=0, must-revalidate");

  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: 404,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    const legacyRoot = LEGACY_ROOTS.find(
      (candidate) => pathname === candidate || pathname.startsWith(`${candidate}/`),
    );

    if (legacyRoot) {
      return redirectLegacyOVOPath(request, legacyRoot);
    }

    if (pathname === OVO_LABS_ROOT) {
      return redirectToOVOLabsRoot(request);
    }

    if (pathname.startsWith(`${OVO_LABS_ROOT}/`)) {
      const assetResponse = await env.ASSETS.fetch(request);
      const response =
        assetResponse.status === 404
          ? await renderOVOLabsNotFound(request, env)
          : assetResponse;
      return withOVOLabsHeaders(response, pathname);
    }

    return vinext.fetch(request, env, ctx);
  },
};
