import { fileItemRoutes } from "@/lib/server/file-routes";

export const dynamic = "force-dynamic";

const routes = fileItemRoutes("boards");

/** Serve one file (`?download=1` forces a download). */
export const GET = routes.GET;
export const DELETE = routes.DELETE;
