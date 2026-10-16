import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, ShieldAlert, ShieldQuestion } from "lucide-react";

import { hostById } from "../store/hosts";
import { usePrompts, type PendingPrompt } from "../store/prompts";
import { Button } from "./ui/Button";
import { Checkbox, Field, Input } from "./ui/Form";
import { Modal } from "./ui/Modal";

/** Shows the oldest question an SSH session is waiting on, if any. */
export function PromptDialog() {
  const prompt = usePrompts((s) => s.queue[0]);
  if (!prompt) return null;
  // `key` resets the form state for each new prompt.
  if (prompt.type === "certificate") return <CertificatePrompt key={prompt.requestId} prompt={prompt} />;
  return prompt.type === "hostKey" ? (
    <HostKeyPrompt key={prompt.requestId} prompt={prompt} />
  ) : (
    <AuthPrompt key={prompt.requestId} prompt={prompt} />
  );
}

function HostKeyPrompt({ prompt }: { prompt: Extract<PendingPrompt, { type: "hostKey" }> }) {
  const { t } = useTranslation();
  const answer = usePrompts((s) => s.answer);
  const host = hostById(prompt.hostId);
  const reply = (accept: boolean) => answer(prompt.requestId, { type: "hostKey", accept });

  return (
    <Modal
      title={prompt.changed ? t("hostKey.changedTitle") : t("hostKey.unknownTitle")}
      icon={prompt.changed ? <ShieldAlert className="size-4" /> : <ShieldQuestion className="size-4" />}
      tone={prompt.changed ? "danger" : "default"}
      onClose={() => reply(false)}
      footer={
        <>
          <Button onClick={() => reply(false)} data-autofocus>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            className={prompt.changed ? "bg-red hover:bg-red hover:opacity-90" : undefined}
            onClick={() => reply(true)}
          >
            {prompt.changed ? t("hostKey.replace") : t("hostKey.trust")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg-secondary">
        {prompt.changed
          ? t("hostKey.changedBody", { host: host?.hostname ?? "" })
          : t("hostKey.unknownBody", { host: host?.hostname ?? "" })}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-card-deep border border-border bg-deep p-3 text-xs">
        <dt className="text-fg-muted">{t("hostKey.server")}</dt>
        <dd className="truncate font-mono text-fg">
          {host ? `${host.hostname}:${host.port}` : "—"}
        </dd>
        <dt className="text-fg-muted">{t("hostKey.algorithm")}</dt>
        <dd className="font-mono text-fg">{prompt.algorithm}</dd>
        <dt className="text-fg-muted">{t("hostKey.fingerprint")}</dt>
        <dd className="select-text break-all font-mono text-fg">{prompt.fingerprint}</dd>
      </dl>
    </Modal>
  );
}

function CertificatePrompt({ prompt }: { prompt: Extract<PendingPrompt, { type: "certificate" }> }) {
  const { t } = useTranslation();
  const answer = usePrompts((s) => s.answer);
  const host = hostById(prompt.hostId);
  const reply = (accept: boolean) => answer(prompt.requestId, { type: "hostKey", accept });

  return (
    <Modal
      title={prompt.changed ? t("certificate.changedTitle") : t("certificate.title")}
      icon={prompt.changed ? <ShieldAlert className="size-4" /> : <ShieldQuestion className="size-4" />}
      tone={prompt.changed ? "danger" : "default"}
      onClose={() => reply(false)}
      footer={
        <>
          <Button onClick={() => reply(false)} data-autofocus>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            className={prompt.changed ? "bg-red hover:bg-red hover:opacity-90" : undefined}
            onClick={() => reply(true)}
          >
            {t("certificate.trust")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg-secondary">
        {prompt.changed ? t("certificate.changedBody", { host: host?.hostname ?? "" }) : t("certificate.body", { host: host?.hostname ?? "" })}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-card-deep border border-border bg-deep p-3 text-xs">
        <dt className="text-fg-muted">{t("hostKey.server")}</dt>
        <dd className="truncate font-mono text-fg">{host ? `${host.hostname}:${host.port}` : "—"}</dd>
        <dt className="text-fg-muted">{t("certificate.reason")}</dt>
        <dd className="break-words text-fg">{prompt.reason}</dd>
        <dt className="text-fg-muted">SHA-256</dt>
        <dd className="select-text break-all font-mono text-fg">{prompt.fingerprint}</dd>
      </dl>
    </Modal>
  );
}

function AuthPrompt({ prompt }: { prompt: Extract<PendingPrompt, { type: "prompt" }> }) {
  const { t } = useTranslation();
  const answer = usePrompts((s) => s.answer);
  const host = hostById(prompt.hostId);
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ""));
  // Saved in the system keychain unless the user unticks it: asking every time is the bigger annoyance.
  const [remember, setRemember] = useState(true);

  const target = host ? `${host.username}@${host.hostname}` : "";
  const title =
    prompt.kind === "password"
      ? t("auth.passwordTitle", { target })
      : prompt.kind === "passphrase"
        ? t("auth.passphraseTitle")
        : prompt.name || t("auth.verificationTitle");

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    answer(prompt.requestId, { type: "answers", answers, remember });
  };
  const cancel = () => answer(prompt.requestId, { type: "cancel" });

  return (
    <Modal
      title={title}
      icon={<KeyRound className="size-4" />}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => submit()}>
            {t("common.continue")}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {prompt.instructions && <p className="text-sm text-fg-secondary">{prompt.instructions}</p>}
        {prompt.retry && <p className="text-sm text-red">{t("auth.retry")}</p>}
        {prompt.prompts.map((field, index) => (
          <Field key={index} label={translatePromptLabel(field.prompt, t)}>
            {(id) => (
              <Input
                id={id}
                type={field.echo ? "text" : "password"}
                value={answers[index]}
                onChange={(e) => setAnswers((all) => all.map((a, i) => (i === index ? e.target.value : a)))}
              />
            )}
          </Field>
        ))}
        {prompt.canRemember && (
          <Checkbox checked={remember} onChange={setRemember}>
            {t("auth.remember")}
          </Checkbox>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** The backend's own labels are translated; server-provided ones (2FA prompts) are shown as is. */
function translatePromptLabel(label: string, t: (key: string) => string): string {
  if (label === "Password:") return t("auth.password");
  if (label === "Key passphrase:") return t("auth.passphrase");
  return label.replace(/:\s*$/, "");
}
