const CANONICAL_HOMEPAGE = "https://allenscarpetinc.com/";
const CANONICAL_CONTACT_PAGE = "https://allenscarpetinc.com/contact";
const LEGACY_CONTACT_PATH = "/Contact_Us.html";
const LEGACY_PATHS = new Set(["/allens-flooring", "/home"]);
const LEGACY_TRACKING_PARAMETERS = ["publisher", "placement"];

function normalizedPath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isLegacyPath = LEGACY_PATHS.has(normalizedPath(url.pathname));
  const hasLegacyTracking = LEGACY_TRACKING_PARAMETERS.some((parameter) =>
    url.searchParams.has(parameter),
  );

  if (url.pathname === LEGACY_CONTACT_PATH) {
    return Response.redirect(CANONICAL_CONTACT_PAGE, 301);
  }

  if (isLegacyPath || hasLegacyTracking) {
    return Response.redirect(CANONICAL_HOMEPAGE, 301);
  }

  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
