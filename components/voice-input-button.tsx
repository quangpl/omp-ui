"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getSpeechRecognition,
  joinTranscript,
  mergeTranscript,
  type SpeechRecognitionLike,
} from "@/lib/speech-input";

const subscribeNever = () => () => {};

/**
 * Microphone toggle for a text field: while listening, the browser's speech recognition
 * (Web Speech API) types what you say at the end of `value`. Renders nothing where the browser
 * has no speech recognition. Typing into the field while listening stops it, so the dictation
 * never overwrites your edits.
 */
export function VoiceInputButton({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const supported = useSyncExternalStore(
    subscribeNever,
    () => getSpeechRecognition() !== null,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** Field values this session produced; any other value means the user edited the field. */
  const emittedRef = useRef<Set<string>>(new Set());
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    let inserted = "";
    let current = valueRef.current;
    emittedRef.current = new Set([current]);
    recognition.onresult = (event) => {
      const merged = mergeTranscript(current, inserted, joinTranscript(event));
      inserted = merged.inserted;
      current = merged.value;
      emittedRef.current.add(current);
      valueRef.current = current;
      onChangeRef.current(current);
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast.error("Microphone access is blocked. Allow it in the browser's site settings to dictate.");
      } else if (event.error === "audio-capture") {
        toast.error("No microphone found.");
      } else if (event.error === "network") {
        toast.error("Speech recognition needs a network connection.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        toast.error(`Voice input failed (${event.error}).`);
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
    }
  }, []);

  // A value this session did not produce is the user's own edit: stop dictating.
  useEffect(() => {
    if (listening && !emittedRef.current.has(value)) stop();
  }, [value, listening, stop]);

  // Release the microphone with the field.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  if (!supported) return null;

  return (
    <Button
      type="button"
      size="icon"
      variant={listening ? "destructive" : "ghost"}
      disabled={disabled}
      aria-label={listening ? "Stop voice input" : "Start voice input"}
      aria-pressed={listening}
      title={listening ? "Stop voice input" : "Voice input"}
      className={cn("shrink-0 pressable-icon", listening && "animate-pulse", className)}
      // Keep the field focused so its caret and keyboard stay put.
      onMouseDown={(event) => event.preventDefault()}
      onClick={listening ? stop : start}
    >
      <Mic />
    </Button>
  );
}
