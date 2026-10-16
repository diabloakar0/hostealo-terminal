import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RefreshCw, Sparkles } from "lucide-react";

import { aiModels, aiSettingsSave, type AiEffort, type AiProvider, type AiSettings } from "../lib/ipc";
import { hasLocalShell } from "../lib/format";
import { useAi } from "../store/ai";
import { Button } from "./ui/Button";
import { Field, Input, Segmented } from "./ui/Form";
import { Modal } from "./ui/Modal";

/** Suggested model per provider when switching; the field stays free text. */
const DEFAULT_MODEL: Record<AiProvider, string> = {
  claudeCode: "opus",
  anthropic: "claude-opus-5-5",
  openai: "",
  ollama: "",
  compatible: "",
};

const DEFAULT_URL: Record<AiProvider, string> = {
  claudeCode: "",
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  ollama: "http://localhost:11434/v1",
  compatible: "",
};

/** Bring your own AI: provider, key (kept in the keychain), server and model. */
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const current = useAi((s) => s.settings);
  const setSettings = useAi((s) => s.setSettings);
  const listId = useId();
  const [form, setForm] = useState<AiSettings>(() => {
    // First time: Claude Code when it is installed (no key needed), else the Claude API.
    if (!current?.saved) {
      const provider: AiProvider = current?.claudeCode ? "claudeCode" : "anthropic";
      return { provider, model: DEFAULT_MODEL[provider], baseUrl: "", effort: "medium" };
    }
    return { ...current.settings, model: current.settings.model || DEFAULT_MODEL[current.settings.provider] };
  });
  const [key, setKey] = useState("");
  const [forgetKey, setForgetKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const provider = form.provider;
  // The stored key belongs to the provider it was saved for.
  const keyStored = !!current?.hasKey && current.settings.provider === provider && !forgetKey;
  const needsKey = provider === "anthropic" || provider === "openai";
  const needsUrl = provider === "compatible";
  const cli = provider === "claudeCode";

  const loadModels = async () => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      setModels(await aiModels(form, key));
    } catch (e) {
      setModels([]);
      setModelsError(String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  // Local servers answer without a key: list their models right away.
  useEffect(() => {
    setModels([]);
    setModelsError(null);
    if (provider === "ollama" || cli || keyStored) void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const switchProvider = (next: AiProvider) => {
    setForm((f) => ({ ...f, provider: next, model: next === current?.settings.provider ? current.settings.model : DEFAULT_MODEL[next], baseUrl: "" }));
    setKey("");
    setForgetKey(false);
  };

  const save = async () => {
    if (!cli && !form.model.trim()) return setError(t("ai.form.modelRequired"));
    if (needsUrl && !form.baseUrl.trim()) return setError(t("ai.form.urlRequired"));
    setSaving(true);
    setError(null);
    try {
      const apiKey = key.trim() ? { action: "set" as const, value: key.trim() } : forgetKey ? { action: "clear" as const } : { action: "keep" as const };
      setSettings(await aiSettingsSave({ ...form, model: form.model.trim(), baseUrl: form.baseUrl.trim() }, apiKey));
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t("ai.form.title")}
      icon={<Sparkles className="size-4" />}
      onClose={onClose}
      className="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">{t("ai.form.provider")}</span>
          <Segmented<AiProvider>
            value={provider}
            onChange={switchProvider}
            options={[
              // Claude Code is a program the app starts, which iOS does not allow.
              ...(hasLocalShell ? [{ value: "claudeCode" as const, label: "Claude Code" }] : []),
              { value: "anthropic", label: t("ai.form.claudeApi") },
              { value: "openai", label: "OpenAI" },
              { value: "ollama", label: "Ollama" },
              { value: "compatible", label: t("ai.form.compatible") },
            ]}
          />
          <p className="text-xs leading-relaxed text-fg-muted">{t(`ai.form.about.${provider}`)}</p>
          {cli && (
            <p className={current?.claudeCode || form.baseUrl ? "text-xs text-green" : "text-xs text-red"}>
              {current?.claudeCode && !form.baseUrl ? t("ai.form.cliFound", { path: current.claudeCode }) : !form.baseUrl && t("ai.form.cliMissing")}
            </p>
          )}
        </div>

        {provider !== "ollama" && !cli && (
          <Field label={t("ai.form.apiKey")} hint={needsKey ? t("ai.form.apiKeyHint") : t("ai.form.apiKeyOptional")}>
            {(id) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onBlur={() => key.trim() && void loadModels()}
                  placeholder={keyStored ? t("host.savedInKeychain") : provider === "anthropic" ? "sk-ant-…" : provider === "openai" ? "sk-…" : t("host.optional")}
                />
                {keyStored && <Button onClick={() => setForgetKey(true)}>{t("host.forget")}</Button>}
              </div>
            )}
          </Field>
        )}

        <Field
          label={cli ? t("ai.form.cliPath") : t("ai.form.baseUrl")}
          hint={cli ? t("ai.form.cliPathHint") : needsUrl ? t("ai.form.baseUrlRequiredHint") : t("ai.form.baseUrlHint")}
        >
          {(id) => (
            <Input
              id={id}
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={cli ? (current?.claudeCode ?? "~/.local/bin/claude") : DEFAULT_URL[provider] || "http://localhost:1234/v1"}
            />
          )}
        </Field>

        <Field
          label={t("ai.form.model")}
          hint={modelsError ? undefined : models.length ? t("ai.form.modelsFound", { count: models.length }) : t("ai.form.modelHint")}
          error={modelsError ? t("ai.form.modelsFailed", { error: modelsError }) : undefined}
        >
          {(id) => (
            <div className="flex gap-2">
              <Input
                id={id}
                list={listId}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder={provider === "ollama" ? "qwen3, llama3.3…" : cli ? t("ai.form.cliModelPlaceholder") : t("ai.form.modelPlaceholder")}
                className="font-mono"
              />
              <datalist id={listId}>
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <Button onClick={() => void loadModels()} disabled={loadingModels} title={t("ai.form.loadModels")} aria-label={t("ai.form.loadModels")}>
                {loadingModels ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              </Button>
            </div>
          )}
        </Field>

        {(provider === "anthropic" || cli) && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">{t("ai.form.effort")}</span>
            <Segmented<AiEffort>
              value={form.effort}
              onChange={(effort) => setForm({ ...form, effort })}
              options={[
                { value: "low", label: t("ai.form.effortLow") },
                { value: "medium", label: t("ai.form.effortMedium") },
                { value: "high", label: t("ai.form.effortHigh") },
              ]}
            />
            <p className="text-xs leading-relaxed text-fg-muted">{t("ai.form.effortHint")}</p>
          </div>
        )}

        <p className="rounded-btn bg-deep px-3 py-2 text-xs leading-relaxed text-fg-muted">{t("ai.form.privacy")}</p>
        {error && <p className="text-sm text-red">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
