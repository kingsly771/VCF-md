/**
 * whatsapp-vcf-bot
 * - Listens for messages starting with "!vcf"
 * - Example single contact command:
 *     !vcf John Doe|+237699000000|Example Org|john@example.com
 * - Example multi-contact command:
 *     !vcf MULTI
 *     Then send messages in format name|phone|org|email each line (bot will convert all lines)
 *
 * Requirements:
 * - Node 18+
 * - Run: npm install && npm start
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@adiwajshing/baileys";
import P from "pino";
import fs from "fs-extra";
import path from "path";

const log = P({ level: "info" });

async function start() {
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [4, 6, 1] })); // fallback
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    logger: log,
    printQRInTerminal: true,
    auth: state,
    version
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.info("connection closed, reconnecting", code || lastDisconnect?.error);
      // Auto-reconnect handled by bailey's internal logic sometimes; for explicit reconnect:
      if (code !== DisconnectReason.loggedOut) start().catch(console.error);
    } else if (connection === 'open') {
      log.info("connected");
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;
      const sender = msg.key.remoteJid;
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

      if (!text) return;

      // Command trigger
      if (text.startsWith("!vcf")) {
        const payload = text.slice(4).trim(); // after command
        if (!payload) {
          await sock.sendMessage(sender, { text: 'Usage:\n!vcf Name|+Phone|Org|email\nOr send !vcf MULTI then lines with Name|Phone|Org|email' });
          return;
        }

        if (payload.toUpperCase() === "MULTI") {
          // Expect next message(s) to contain lines; for simplicity we'll look at quoted message if exists,
          // or instruct user to send the lines in one message separated by newlines.
          await sock.sendMessage(sender, { text: 'Send the contacts in one message with each contact on its own line using format:\nName|+Phone|Org|email\n\nExample:\nJohn Doe|+237699000000|Org|john@example.com\nJane Doe|+237699111111|Org2|jane@example.com' });
          return;
        }

        // If single-line possibly containing newlines => treat as multiple
        const lines = payload.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const contacts = lines.map(line => parseContactLine(line)).filter(Boolean);

        if (contacts.length === 0) {
          await sock.sendMessage(sender, { text: "Couldn't parse contact. Use format: Name|+Phone|Org|email" });
          return;
        }

        const vcfText = buildVCardMulti(contacts);
        const tmpDir = path.join(process.cwd(), "tmp");
        await fs.ensureDir(tmpDir);
        const filePath = path.join(tmpDir, `contacts-${Date.now()}.vcf`);
        await fs.writeFile(filePath, vcfText, "utf8");

        // Send vcf as document
        await sock.sendMessage(sender, {
          document: fs.createReadStream(filePath),
          fileName: "contacts.vcf",
          mimetype: "text/vcard",
          caption: `VCF with ${contacts.length} contact(s)`
        });

        // cleanup
        setTimeout(() => fs.remove(filePath).catch(()=>{}), 60_000);
      }

      // Optional: quick helper to convert a forwarded contact into .vcf (if user sends contact)
      if (msg.message?.contactMessage) {
        // If the user sent an in-chat contact, reply with a vcf
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
          fileName: `${name.replace(/\s+/g,"_")}.vcf`,
          mimetype: "text/vcard",
          caption: `Here's the VCF for ${name}`
        });
        setTimeout(() => fs.remove(filePath).catch(()=>{}), 60_000);
      }

    } catch (err) {
      console.error("message handler error:", err);
    }
  });
}

function parseContactLine(line) {
  // Accept: Name|Phone|Org|email  (org & email optional)
  const parts = line.split("|").map(p => p.trim());
  if (parts.length < 2) return null;
  const name = parts[0] || "Unknown";
  const phone = parts[1] || "";
  const org = parts[2] || "";
  const email = parts[3] || "";
  return { name, phone, org, email };
}

function sanitizePhoneForVcard(phone) {
  // remove spaces, parentheses; keep + and digits
  return (phone || "").replace(/[^\d+]/g, "");
}

function buildVCardSingle({ name, phone, org, email }) {
  const tel = sanitizePhoneForVcard(phone);
  const escapedName = (name || "").replace(/,/g, "\\,");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapedName}`,
    // split name into N field (Lastname;Firstname;additional;prefix;suffix) - we keep simple
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

// Start bot
start().catch(err => {
  console.error("start failed", err);
  process.exit(1);
});
