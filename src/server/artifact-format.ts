import { deliverableCatalog, type DeliverableKind } from "../contracts/requests";

function validZip(bytes: Buffer): boolean {
  // Accept a bounded, single-disk ZIP with a central directory. Never extract or execute content.
  const minimum = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue;
    if (bytes.readUInt32LE(offset + 4) !== 0) return false;
    const count = bytes.readUInt16LE(offset + 10);
    if (count < 1 || count > 256 || count !== bytes.readUInt16LE(offset + 8)) return false;
    let cursor = bytes.readUInt32LE(offset + 16);
    if (cursor + bytes.readUInt32LE(offset + 12) !== offset) return false;
    for (let entry = 0; entry < count; entry++) {
      if (cursor + 46 > offset || bytes.readUInt32LE(cursor) !== 0x02014b50) return false;
      const local = bytes.readUInt32LE(cursor + 42);
      if (local + 30 > cursor || bytes.readUInt32LE(local) !== 0x04034b50) return false;
      cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    return cursor === offset;
  }
  return false;
}

function validCsv(value: string): boolean {
  // RFC 4180 fields, with LF also permitted. Require a consistent number of columns.
  const field = /(?:"(?:[^"]|"")*"|[^",\r\n]*)(,|\r?\n|$)/gy;
  let cursor = 0;
  let width = 0;
  let columns = 0;
  while (cursor < value.length) {
    const match = field.exec(value);
    if (!match || field.lastIndex <= cursor) return false;
    cursor = field.lastIndex;
    columns++;
    if (match[1] === ",") {
      if (cursor === value.length) columns++;
      else continue;
    }
    width ||= columns;
    if (width !== columns) return false;
    columns = 0;
  }
  return width > 0;
}

export function validArtifact(kind: DeliverableKind, fileName: string, bytes: Buffer): boolean {
  const { extension } = deliverableCatalog[kind];
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(fileName) || !fileName.toLowerCase().endsWith("." + extension)) return false;
  if (extension === "zip") return validZip(bytes);
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) &&
      (extension !== "csv" || validCsv(value));
  } catch {
    return false;
  }
}
