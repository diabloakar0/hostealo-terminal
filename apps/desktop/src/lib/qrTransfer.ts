/**
 * The QR codes of a transfer of servers (sync/qr.rs): each is a link
 * `hostealo-terminal://qr?s=<transfer>&i=<part>&n=<parts>&k=<code>&d=<data>`. The phone reads them
 * in any order (the computer shows them in turn) until it has every part.
 */
export const QR_PREFIX = "hostealo-terminal://qr?";

export interface QrFrame {
  transfer: string;
  index: number;
  total: number;
  /** The code travels inside when the passwords do not: then nothing has to be typed. */
  needsCode: boolean;
}

export function parseQrFrame(text: string): QrFrame | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(QR_PREFIX)) return null;
  const params = new URLSearchParams(trimmed.slice(QR_PREFIX.length));
  const index = Number(params.get("i"));
  const total = Number(params.get("n"));
  const transfer = params.get("s");
  if (!transfer || !Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total || !params.has("d")) return null;
  return { transfer, index, total, needsCode: params.get("k") === "" };
}

export interface QrCollection {
  transfer: string;
  total: number;
  needsCode: boolean;
  /** The text of each part read, by part number. */
  parts: Map<number, string>;
}

/**
 * Adds a code read to what was collected: a part of another transfer starts over (the user
 * opened a new one on the computer). Returns the same collection when nothing changed.
 */
export function collectQrFrame(collection: QrCollection | null, text: string): QrCollection | null {
  const frame = parseQrFrame(text);
  if (!frame) return collection;
  const same = collection && collection.transfer === frame.transfer && collection.total === frame.total;
  if (same && collection.parts.has(frame.index)) return collection;
  const parts = new Map(same ? collection.parts : []);
  parts.set(frame.index, text.trim());
  return { transfer: frame.transfer, total: frame.total, needsCode: frame.needsCode, parts };
}

export const qrComplete = (collection: QrCollection | null): collection is QrCollection => !!collection && collection.parts.size === collection.total;

/** `K7QM2XPA` as `K7QM-2XPA`, easier to read out and type. */
export const formatTransferCode = (code: string) => code.replace(/^(.{4})(.+)$/, "$1-$2");
