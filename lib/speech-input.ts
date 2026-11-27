/** Minimal Web Speech API surface; `lib.dom` does not ship these types. */
export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
export interface SpeechRecognitionResultLike {
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionErrorEventLike {
  error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The browser's speech recognizer (Chromium and Safari expose it prefixed); null when unsupported. */
export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** All recognized text of one session (final and interim parts), trimmed. */
export function joinTranscript(event: SpeechRecognitionEventLike): string {
  let text = "";
  for (let i = 0; i < event.results.length; i++) text += event.results[i][0]?.transcript ?? "";
  return text.trim();
}

/**
 * Put `transcript` at the end of `current`, replacing what the previous call inserted
 * (`previous`, the interim text being refined). A space separates it from existing text.
 * Returns the new field value and the inserted piece to pass as `previous` next time.
 */
export function mergeTranscript(
  current: string,
  previous: string,
  transcript: string,
): { value: string; inserted: string } {
  const base = previous && current.endsWith(previous) ? current.slice(0, current.length - previous.length) : current;
  if (!transcript) return { value: base, inserted: "" };
  const inserted = (base && !/\s$/.test(base) ? " " : "") + transcript;
  return { value: base + inserted, inserted };
}
