"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ENV_KEY_PATTERN, type EnvVar, parseDotenv } from "@/lib/env-vars";

interface Props {
  vars: EnvVar[];
  /** Add or overwrite; rejects (after toasting) when the server refuses. */
  onSet: (values: Record<string, string>) => Promise<void>;
  onRemove: (key: string) => Promise<void>;
}

/** One saved variable: edit the value in place (saved on blur or Enter), reveal it, delete it. */
function Row({ item, onSet, onRemove }: { item: EnvVar } & Pick<Props, "onSet" | "onRemove">) {
  const [value, setValue] = useState(item.value);
  const [shown, setShown] = useState(false);
  const save = () => {
    if (value !== item.value) void onSet({ [item.key]: value }).catch(() => setValue(item.value));
  };
  return (
    <div className="flex items-center gap-2">
      <code className="w-1/3 min-w-0 truncate rounded-md bg-muted px-2 py-2 font-mono text-sm" title={item.key}>
        {item.key}
      </code>
      <Input
        className="min-w-0 flex-1 font-mono"
        type={shown ? "text" : "password"}
        autoComplete="off"
        aria-label={`Value of ${item.key}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <Button variant="ghost" size="icon" aria-label={shown ? "Hide value" : "Reveal value"} onClick={() => setShown(!shown)}>
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button variant="ghost" size="icon" aria-label={`Delete ${item.key}`} onClick={() => void onRemove(item.key).catch(() => {})}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

export function EnvVarsEditor({ vars, onSet, onRemove }: Props) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [bulk, setBulk] = useState("");

  const keyInvalid = key !== "" && !ENV_KEY_PATTERN.test(key);
  const bulkVars = parseDotenv(bulk);
  const bulkCount = Object.keys(bulkVars).length;

  async function add() {
    await onSet({ [key]: value });
    setKey("");
    setValue("");
  }

  return (
    <div className="space-y-3">
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add().catch(() => {});
        }}
      >
        <Input
          className="w-1/3 min-w-0 font-mono"
          placeholder="KEY"
          autoComplete="off"
          aria-label="New variable name"
          aria-invalid={keyInvalid}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          // Pasting `KEY=value` lines here fills the .env box below instead.
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!/[=\n]/.test(text)) return;
            e.preventDefault();
            setBulk(text);
          }}
        />
        <Input
          className="min-w-0 flex-1 font-mono"
          placeholder="value"
          autoComplete="off"
          aria-label="New variable value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={!key || keyInvalid} className="gap-1.5">
          <PlusIcon />
          Add
        </Button>
      </form>
      {keyInvalid && <p className="text-xs text-destructive">Letters, digits and _ only; it must not start with a digit.</p>}

      {vars.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No variables yet.</p>
      ) : (
        <div className="space-y-2">
          {vars.map((item) => (
            // Re-mounts when the saved value changes (after a save or a reload).
            <Row key={`${item.key}:${item.updatedAt}`} item={item} onSet={onSet} onRemove={onRemove} />
          ))}
        </div>
      )}

      <details className="rounded-lg border px-3 py-2" open={bulk !== ""}>
        <summary className="cursor-pointer text-sm font-medium">Paste a .env file</summary>
        <div className="space-y-2 pt-2">
          <Textarea
            className="min-h-32 font-mono text-sm"
            placeholder={"API_URL=https://example.com\nTOKEN=abc123"}
            aria-label=".env contents"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
          />
          <Button
            disabled={bulkCount === 0}
            onClick={() =>
              void onSet(bulkVars).then(
                () => setBulk(""),
                () => {},
              )
            }
          >
            Add {bulkCount} variable{bulkCount === 1 ? "" : "s"}
          </Button>
        </div>
      </details>
    </div>
  );
}
