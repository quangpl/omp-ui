import { CREDENTIALS_CHANGED_EVENT } from "@/components/credentials/credential-notifications";

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Tells the notification bell (and anything else listening) that credentials changed. */
export function notifyCredentialsChanged(): void {
  window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT));
}
