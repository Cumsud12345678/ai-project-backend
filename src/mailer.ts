import nodemailer from "nodemailer";

export type Mailer = { send(to: string, subject: string, text: string): Promise<void> };

export function createMailer(smtpUrl: string | undefined, from: string): Mailer {
  if (!smtpUrl) {
    // İnkişaf rejimi: email göndərilmir, mətn konsola yazılır.
    return { async send(to, subject, text) { console.log(`\n[mail → ${to}] ${subject}\n${text}\n`); } };
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return { async send(to, subject, text) { await transport.sendMail({ from, to, subject, text }); } };
}
