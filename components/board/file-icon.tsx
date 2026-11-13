import { FileCode, FileText, type LucideIcon } from "lucide-react";

/** Extensions shown with the code-file icon. */
const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|php|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|hpp|cs|m|mm|sh|bash|zsh|fish|ps1|lua|pl|r|dart|ex|exs|erl|hs|clj|vue|svelte|astro|html?|css|scss|sass|less|json|jsonc|ya?ml|toml|xml|sql|graphql|gql|proto|zig|nix)$/i;

/** Icon for a file by name or path: code icon for source extensions, text icon otherwise. */
export function fileIcon(name: string): LucideIcon {
  return CODE_FILE.test(name) ? FileCode : FileText;
}
