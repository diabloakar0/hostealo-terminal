import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, LoaderCircle } from "lucide-react";

import { sshKeysDefaultComment, sshKeysGenerate, type KeyAlgorithm, type SshKeyInfo } from "../lib/ipc";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";
import { Field, Input, Segmented } from "./ui/Form";
import { Modal } from "./ui/Modal";

const DEFAULT_NAMES: Record<KeyAlgorithm, string> = { ed25519: "id_ed25519", ecdsa: "id_ecdsa", rsa: "id_rsa" };

/** `id_ed25519`, or `id_ed25519_2`... when taken. */
function freeName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base}_${i}`)) return `${base}_${i}`;
}

interface GenerateKeyDialogProps {
  existing: string[];
  onClose: () => void;
  onGenerated: (key: SshKeyInfo) => void;
}

export function GenerateKeyDialog({ existing, onClose, onGenerated }: GenerateKeyDialogProps) {
  const { t } = useTranslation();
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [name, setName] = useState(freeName(DEFAULT_NAMES.ed25519, existing));
  const [nameTouched, setNameTouched] = useState(false);
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<SshKeyInfo | null>(null);

  useEffect(() => {
    void sshKeysDefaultComment().then((c) => setComment((current) => current || c));
  }, []);

  const changeAlgorithm = (next: KeyAlgorithm) => {
    setAlgorithm(next);
    if (!nameTouched) setName(freeName(DEFAULT_NAMES[next], existing));
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (passphrase !== confirmation) {
      setError(t("keys.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const key = await sshKeysGenerate(name.trim(), algorithm, passphrase, comment.trim());
      setCreated(key);
      onGenerated(key);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal title={t("keys.createdTitle")} icon={<KeyRound className="size-4" />} onClose={onClose} className="max-w-lg"
        footer={<Button variant="primary" onClick={onClose}>{t("common.done")}</Button>}
      >
        <p className="text-sm text-fg-secondary">{t("keys.createdBody", { path: created.path })}</p>
        <pre className="mt-3 max-h-32 overflow-auto rounded-card-deep border border-border bg-deep p-3 font-mono text-xs break-all whitespace-pre-wrap text-fg select-text">
          {created.publicKey}
        </pre>
        <div className="mt-3">{created.publicKey && <CopyButton text={created.publicKey} />}</div>
      </Modal>
    );
  }

  return (
    <Modal
      title={t("keys.generateTitle")}
      icon={<KeyRound className="size-4" />}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy && <LoaderCircle className="size-4 animate-spin" />}
            {busy ? t("keys.generating") : t("keys.generate")}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">{t("keys.type")}</span>
          <Segmented<KeyAlgorithm>
            value={algorithm}
            onChange={changeAlgorithm}
            options={[
              { value: "ed25519", label: "Ed25519" },
              { value: "ecdsa", label: "ECDSA" },
              { value: "rsa", label: "RSA 4096" },
            ]}
          />
          <p className="text-xs text-fg-muted">{algorithm === "ed25519" ? t("keys.ed25519Hint") : algorithm === "rsa" ? t("keys.rsaHint") : t("keys.ecdsaHint")}</p>
        </div>
        <Field label={t("keys.name")} hint={t("keys.nameHint")}>
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              className="font-mono text-[13px]"
            />
          )}
        </Field>
        <Field label={t("keys.comment")}>{(id) => <Input id={id} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("host.passphrase")} hint={t("keys.passphraseHint")}>
            {(id) => <Input id={id} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={t("host.optional")} />}
          </Field>
          <Field label={t("keys.confirm")}>
            {(id) => <Input id={id} type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />}
          </Field>
        </div>
        {error && <p className="text-sm text-red">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
