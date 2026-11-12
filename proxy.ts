// Edge-safe page guard: only checks that a session cookie is present. Tokens are verified by
// the API routes; the UI client redirects to /login on any 401. Never import node-only modules
// or the database here.
import { NextResponse, type NextRequest } from "next/server";

/** Same value as SESSION_COOKIE in lib/auth.ts (not imported: that module is Node-only). */
const SESSION_COOKIE = "omp_ui_token";

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/login/")) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/|assets/|manifest\\.webmanifest$|favicon\\.ico$|icon|.*\\..*).*)",
  ],
};
