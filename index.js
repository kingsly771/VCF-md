/**
 * whatsapp-vcf-bot
 * - Listens for messages starting with "!vcf"
 * - Example single contact command:
 *     !vcf John Doe|+237699000000|Example Org|john@example.com
 * - Example multi-contact command:
 *     !vcf MULTI
 *     Then send messages in format name|phone|org|email each line (bot will convert all lines)
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@adiwajshing/baileys";
import P from "pino";
import fs from "fs-extra";
import path from "path";

const log = P({ level: "info" });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  // ✅ Safe version fetch with fallback
  let waVersion;
  try {
    const latest = await fetchLatestBaileysVersion();
    waVersion = latest.version;
  } catch (e) {
    console.log("⚠️ Could not fetch latest Baileys version, using fallback.");
    waVersion = [2, 3000, 0];
  }

  // ✅ No more error at line 26
  const sock = makeWASocket({
    logger: log,
    printQRInTerminal: true,
    auth: state,
    version: waVersion
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.info("connection closed, reconnecting", code || lastDisconnect?.error);
      if (code !== DisconnectReason.loggedOut) start().catch(console.error);
    } else if (connection === "open") {
      log.info("✅ Connected to WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;
      const sender = msg.key.remoteJid;
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

      if (!text) return;

      if (text.startsWith("!vcf")) {
        const payload = text.slice(4).trim();
        if (!payload) {
          await sock.sendMessage(sender, {
            text: "Usage:\n!vcf Name|+Phone|Org|email\nOr send multiple contacts separated by newlines."
          });
          return;
        }

        const lines = payload.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const contacts = lines.map(line => parseContactLine(line)).filter(Boolean);

        if (contacts.length === 0) {
          await sock.sendMessage(sender, { text: "❌ Couldn't parse contact. Use format: Name|+Phone|Org|email" });
          return;
        }

        const vcfText = buildVCardMulti(contacts);
        const tmpDir = path.join(process.cwd(), "tmp");
        await fs.ensureDir(tmpDir);
        const filePath = path.join(tmpDir, `contacts-${Date.now()}.vcf`);
        await fs.writeFile(filePath, vcfText, "utf8");

        await sock.sendMessage(sender, {
          document: fs.createReadStream(filePath),
          fileName: "contacts.vcf",
          mimetype: "text/vcard",
          caption: `📇 VCF with ${contacts.length} contact(s)`
        });

        setTimeout(() => fs.remove(filePath).catch(() => {}), 60_000);
      }

      if (msg.message?.contactMessage) {
        const contact = msg.message.contactMessage;
        const phone = contact.vcard ? extractPhoneFromVcard(contact.vcard) : (contact.jid || "").split("@")[0];
        const name = contact.displayName || contact.vcard?.match(/FN:(.*)/)?.[1] || "contact";
        const vcfText = buildVCardSingle({ name, phone, org: "", email: "" });
        const tmpDir = path.join(process.cwd(), "tmp");
        await fs.ensureDir(tmpDir);
        const filePath = path.join(tmpDir, `contact-${Date.now()}.vcf`);
        await fs.writeFile(filePath, vcfText, "utf8");
        await sock.sendMessage(sender, {
          document: fs.createReadStream(filePath),
          fileName: `${name.replace(/\s+/g, "_")}.vcf`,
          mimetype: "text/vcard",
          caption: `📇 Here's the VCF for ${name}`
        });
        setTimeout(() => fs.remove(filePath).catch(() => {}), 60_000);
      }

    } catch (err) {
      console.error("message handler error:", err);
    }
  });
}

function parseContactLine(line) {
  const parts = line.split("|").map(p => p.trim());
  if (parts.length < 2) return null;
  return {
    name: parts[0] || "Unknown",
    phone: parts[1] || "",
    org: parts[2] || "",
    email: parts[3] || ""
  };
}

function sanitizePhoneForVcard(phone) {
  return (phone || "").replace(/[^\d+]/g, "");
}

function buildVCardSingle({ name, phone, org, email }) {
  const tel = sanitizePhoneForVcard(phone);
  const escapedName = (name || "").replace(/,/g, "\\,");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapedName}`,
    `N:${escapedName};;;;`,
  ];
  if (org) lines.push(`ORG:${org}`);
  if (tel) lines.push(`TEL;TYPE=CELL:${tel}`);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${email}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

function buildVCardMulti(contacts) {
  return contacts.map(c => buildVCardSingle(c)).join("\r\n");
}

function extractPhoneFromVcard(vcardText) {
  const m = vcardText.match(/TEL[^:]*:(\+?\d+)/i);
  return m ? m[1] : "";
}

start().catch(err => {
  console.error("❌ start failed", err);
  process.exit(1);
});
