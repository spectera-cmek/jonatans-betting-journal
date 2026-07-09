// Agent helper: mejla en rapport (t.ex. morgonrättningen) via Gmail SMTP.
//
// Usage:
//   npx tsx scripts/agent/sendReport.ts --subject "Ämne" --body-file <fil.txt> [--to adress]
//   ... | npx tsx scripts/agent/sendReport.ts --subject "Ämne"        (body från stdin)
//
// Kräver i .env.local (aldrig incheckat):
//   GMAIL_USER          — gmail-adressen som skickar (och tar emot som default)
//   GMAIL_APP_PASSWORD  — app-lösenord (kräver 2FA; myaccount.google.com/apppasswords)
//
// Gmail-SMTP används eftersom Gmail-integrationen i Claude bara kan skapa utkast.

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "fs";
import nodemailer from "nodemailer";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const subject = arg("--subject");
  const bodyFile = arg("--body-file");
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const to = arg("--to") ?? process.env.GMAIL_TO ?? "ompamamma@gmail.com";

  if (!subject) {
    console.error('Usage: npx tsx scripts/agent/sendReport.ts --subject "Ämne" [--body-file <fil>] [--to adress]');
    process.exit(1);
  }
  if (!user || !pass) {
    console.error("GMAIL_USER och/eller GMAIL_APP_PASSWORD saknas i .env.local — kan inte skicka mejl.");
    process.exit(1);
  }

  const body = bodyFile ? readFileSync(bodyFile, "utf8") : readFileSync(0, "utf8");
  if (!body.trim()) {
    console.error("Tom rapport — inget att skicka.");
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const info = await transport.sendMail({ from: user, to, subject, text: body });
  console.log(`OK: mejl skickat till ${to} (${info.messageId})`);
}

main().catch((e) => {
  console.error("Mejlet kunde inte skickas:", e instanceof Error ? e.message : e);
  process.exit(1);
});
