import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { FolderOpen, KeyRound, Lock, Plus, RefreshCw, Trash2, Unlock } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { sshKeysDelete, sshKeysList, type SshKeyInfo } from "../lib/ipc";
import { ConfirmDialog } from "./ConfirmDialog";
import { GenerateKeyDialog } from "./GenerateKeyDialog";
import { Button } from "./ui/Button";
import { CopyButton } from "./ui/CopyButton";
import { Badge, Page } from "./ui/Page";

export function KeysView() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState<SshKeyInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await sshKeysList());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => void load(), [load]);

  return (
    <Page
      icon={<KeyRound className="size-5" />}
      title={t("keys.title")}
      description={t("keys.description")}
      actions={
        <>
          <Button onClick={() => void load()} title={t("common.refresh")} aria-label={t("common.refresh")}>
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="primary" onClick={() => setGenerating(true)}>
            <Plus className="size-4" />
            {t("keys.generate")}
          </Button>
        </>
      }
    >
      {error && <p className="text-sm text-red">{error}</p>}

      {loaded && keys.length === 0 && !error && (
        <div className="rounded-card border border-dashed border-border px-6 py-12 text-center">
          <KeyRound className="mx-auto mb-3 size-8 text-fg-muted" />
          <p className="text-sm font-medium text-fg">{t("keys.empty")}</p>
          <p className="mt-1 text-sm text-fg-muted">{t("keys.emptyHint")}</p>
          <Button variant="primary" className="mt-4" onClick={() => setGenerating(true)}>
            <Plus className="size-4" />
            {t("keys.generate")}
          </Button>
        </div>
      )}

      <div className="grid gap-3">
        {keys.map((key) => (
          <KeyCard key={key.path} sshKey={key} onDelete={() => setDeleting(key)} />
        ))}
      </div>

      {keys.length > 0 && <p className="text-xs text-fg-muted">{t("keys.usageHint")}</p>}

      {generating && (
        <GenerateKeyDialog
          existing={keys.map((k) => k.name)}
          onClose={() => setGenerating(false)}
          onGenerated={() => void load()}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("keys.deleteTitle")}
          confirmLabel={t("sidebar.delete")}
          onConfirm={async () => {
            await sshKeysDelete(deleting.path);
            await load();
          }}
          onClose={() => setDeleting(null)}
        >
          <Trans i18nKey="keys.deleteBody" values={{ path: deleting.path }} components={{ b: <strong className="break-all font-mono text-fg" /> }} />
        </ConfirmDialog>
      )}
    </Page>
  );
}

function KeyCard({ sshKey, onDelete }: { sshKey: SshKeyInfo; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <article className="flex items-start gap-4 rounded-card border border-border bg-card p-4 shadow-sm">
      <div className="grid size-9 shrink-0 place-items-center rounded-btn bg-badge text-accent">
        <KeyRound className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-medium tracking-normal text-fg">{sshKey.name}</h3>
          <Badge tone="info">{sshKey.keyType}</Badge>
          {sshKey.encrypted ? (
            <Badge tone="success">
              <Lock className="size-3" />
              {t("keys.encrypted")}
            </Badge>
          ) : (
            <Badge tone="warning">
              <Unlock className="size-3" />
              {t("keys.notEncrypted")}
            </Badge>
          )}
        </div>
        <p className="mt-1.5 truncate font-mono text-xs text-fg-secondary select-text">{sshKey.fingerprint ?? "—"}</p>
        {sshKey.comment && <p className="mt-0.5 truncate text-xs text-fg-muted">{sshKey.comment}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {sshKey.publicKey && <CopyButton text={sshKey.publicKey} />}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => void revealItemInDir(sshKey.path)}
          title={t("keys.reveal")}
          aria-label={t("keys.reveal")}
        >
          <FolderOpen className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8 hover:text-red" onClick={onDelete} title={t("sidebar.delete")} aria-label={t("sidebar.delete")}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </article>
  );
}
