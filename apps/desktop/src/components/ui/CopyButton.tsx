import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

import { Button, type ButtonProps } from "./Button";

export function CopyButton({ text, label, variant }: { text: string; label?: string; variant?: ButtonProps["variant"] }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size="sm" variant={variant} onClick={() => void copy()}>
      {copied ? <Check className="size-3.5 text-green" /> : <Copy className="size-3.5" />}
      {copied ? t("keys.copied") : (label ?? t("keys.copyPublic"))}
    </Button>
  );
}
