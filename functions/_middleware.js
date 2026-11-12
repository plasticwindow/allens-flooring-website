const CANONICAL_HOMEPAGE = "https://allenscarpetinc.com/";
const CANONICAL_CONTACT_PAGE = "https://allenscarpetinc.com/contact";
const LEGACY_CONTACT_PATH = "/Contact_Us.html";
const LEGACY_PATHS = new Set(["/about-us", "/allens-flooring", "/home", "/index.html"]);
const CLEAN_PATH_REDIRECTS = new Map([
  ["/contact.html", CANONICAL_CONTACT_PAGE],
  ["/contact/", CANONICAL_CONTACT_PAGE],
  ["/carpet-cleaning.html", "https://allenscarpetinc.com/carpet-cleaning"],
  ["/carpet-cleaning/", "https://allenscarpetinc.com/carpet-cleaning"],
]);
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

  if (CLEAN_PATH_REDIRECTS.has(url.pathname)) {
    return Response.redirect(CLEAN_PATH_REDIRECTS.get(url.pathname), 301);
  }

  if (isLegacyPath || hasLegacyTracking) {
    return Response.redirect(CANONICAL_HOMEPAGE, 301);
  }

  if (url.hostname === "www.allenscarpetinc.com") {
    url.protocol = "https:";
    url.hostname = "allenscarpetinc.com";
    return Response.redirect(url.toString(), 301);
  }

  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
