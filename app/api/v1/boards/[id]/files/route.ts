import { fileListRoutes } from "@/lib/server/file-routes";

export const dynamic = "force-dynamic";

const routes = fileListRoutes("boards");

/** Shared files of the board. */
export const GET = routes.GET;
/** Upload one file: `?name=<file name>`, raw file as the body. */
export const POST = routes.POST;
