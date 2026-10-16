import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "./Button";
import { Field, Input } from "./Form";
import { Modal } from "./Modal";

interface NameDialogProps {
  title: string;
  icon: ReactNode;
  initial: string;
  label?: string;
  /** Allow "/" in the name (folder paths). */
  allowSlash?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

/** Asks for a single name (new folder, rename...). */
export function NameDialog({ title, icon, initial, label, allowSlash = false, onClose, onSubmit }: NameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() !== "" && (allowSlash || !name.includes("/"));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!valid) return;
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal
      title={title}
      icon={icon}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <Field label={label ?? t("sftp.name")} error={error}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}
