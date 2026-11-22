// Custom environment variables set in the UI (/env) and handed to every agent child process.
// Shared by the client and the server: no Node imports here.

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VALUE_LENGTH = 16 * 1024;

export interface EnvVar {
  key: string;
  value: string;
  updatedAt: string;
}

export interface EnvVarsResponse {
  vars: EnvVar[];
}

/** Parse `.env`-style text: `KEY=value` and `export KEY=value` lines, `#` comments, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([^=\s#]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[m[1]] = value;
  }
  return out;
}
