"use client";

// Knapp: ladda upp en kvitto-skärmdump → AI-tolkning → förifyllda bets.
// Bilden komprimeras klientsidigt (canvas → JPEG, max 1600 px långsida) så att
// råa mobilskärmdumpar klarar Vercels body-gräns och HEIC normaliseras bort.

import { useRef, useState } from "react";
import { api } from "@/lib/fetcher";
import { I, IC } from "./icons";
import type { ParsedBetWithDupe } from "@/lib/betslipExtract";

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

async function fileToJpegBase64(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Kunde inte läsa bilden — spara skärmdumpen som JPEG/PNG och försök igen");
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Kunde inte bearbeta bilden");
  ctx.fillStyle = "#fff"; // transparenta PNG:er ska inte bli svarta i JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("Kunde inte bearbeta bilden");
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Kunde inte bearbeta bilden"));
    r.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

interface Props {
  onParsed: (bets: ParsedBetWithDupe[]) => void;
}

export function ScreenshotImportButton({ onParsed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | null | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const imageBase64 = await fileToJpegBase64(file);
      const res = await api.post<{ bets: ParsedBetWithDupe[] }>("/api/bets/parse-screenshot", {
        imageBase64,
        mediaType: "image/jpeg",
      });
      if (!res.bets.length) {
        alert("Inga bets hittades i bilden.");
        return;
      }
      onParsed(res.bets);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = ""; // samma fil ska kunna väljas igen
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <button
        className="ap-btn ghost"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Logga bet från kvitto-skärmdump"
      >
        <I p={IC.upload} size={15} />
        <span className="ap-hide-sm">{busy ? "Tolkar kvitto…" : "Från kvitto"}</span>
      </button>
    </>
  );
}
