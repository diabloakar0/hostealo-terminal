import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Defaults to a bin: most confirmations are about deleting something. */
  icon?: ReactNode;
  /** Red, for destructive actions (the default). */
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/** Confirmation for destructive actions. */
export function ConfirmDialog({ title, children, confirmLabel, icon, danger = true, onConfirm, onClose }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      icon={icon ?? <Trash2 className="size-4" />}
      tone={danger ? "danger" : "default"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" className={danger ? "bg-red hover:bg-red hover:opacity-90" : undefined} onClick={() => void confirm()} disabled={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-fg-secondary">{children}</div>
      {error && <p className="mt-3 text-sm text-red">{error}</p>}
    </Modal>
  );
}
