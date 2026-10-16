import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, Settings } from "lucide-react";

import { useSettings, type LanguagePreference, type ThemePreference } from "../store/settings";
import { Button } from "./ui/Button";
import { Checkbox, Segmented } from "./ui/Form";
import { Modal } from "./ui/Modal";

const MIN_FONT = 10;
const MAX_FONT = 24;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { theme, language, fontSize, highlightOutput, alertsEnabled, alertsNotify, alertDisk, alertMemory, alertCpu, update } = useSettings();

  return (
    <Modal title={t("settings.title")} icon={<Settings className="size-4" />} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <Section label={t("settings.language")}>
          <Segmented<LanguagePreference>
            value={language}
            onChange={(language) => update({ language })}
            options={[
              { value: "system", label: t("settings.system") },
              { value: "en", label: "English" },
              { value: "es", label: "Español" },
            ]}
          />
        </Section>

        <Section label={t("settings.theme")}>
          <Segmented<ThemePreference>
            value={theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: "system", label: t("settings.system") },
              { value: "dark", label: t("settings.dark") },
              { value: "light", label: t("settings.light") },
            ]}
          />
        </Section>

        <Section label={t("settings.fontSize")}>
          <div className="flex items-center gap-2">
            <Button size="icon" onClick={() => update({ fontSize: Math.max(MIN_FONT, fontSize - 1) })} aria-label="-">
              <Minus className="size-3.5" />
            </Button>
            <span className="w-10 text-center text-sm tabular-nums text-fg">{fontSize}px</span>
            <Button size="icon" onClick={() => update({ fontSize: Math.min(MAX_FONT, fontSize + 1) })} aria-label="+">
              <Plus className="size-3.5" />
            </Button>
          </div>
        </Section>

        <div className="flex flex-col gap-1.5">
          <Checkbox checked={highlightOutput} onChange={(highlightOutput) => update({ highlightOutput })}>
            <span className="font-medium text-fg">{t("settings.highlight")}</span>
          </Checkbox>
          <p className="pl-6 text-xs leading-relaxed text-fg-muted">{t("settings.highlightHint")}</p>
        </div>

        <Section label={t("settingsAlerts.title")}>
          <Checkbox checked={alertsEnabled} onChange={(alertsEnabled) => update({ alertsEnabled })}>
            {t("settingsAlerts.enabled")}
          </Checkbox>
          {alertsEnabled && (
            <>
              <Checkbox checked={alertsNotify} onChange={(alertsNotify) => update({ alertsNotify })}>
                {t("settingsAlerts.notify")}
              </Checkbox>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(
                  [
                    ["alertDisk", alertDisk, t("settingsAlerts.disk")],
                    ["alertMemory", alertMemory, t("settingsAlerts.memory")],
                    ["alertCpu", alertCpu, t("settingsAlerts.cpu")],
                  ] as const
                ).map(([key, value, label]) => (
                  <label key={key} className="flex flex-col gap-1 rounded-card border border-border px-3 py-2">
                    <span className="text-xs text-fg-muted">
                      {label} · {t("settingsAlerts.threshold")}
                    </span>
                    <span className="flex items-center gap-1">
                      <select
                        value={value}
                        onChange={(e) => update({ [key]: Number(e.target.value) })}
                        className="cursor-pointer bg-transparent text-sm font-medium text-fg outline-none"
                      >
                        {[70, 75, 80, 85, 90, 95].map((n) => (
                          <option key={n} value={n}>
                            {n} %
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </Section>
      </div>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
    </div>
  );
}
