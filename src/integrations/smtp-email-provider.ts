import nodemailer from "nodemailer";
import type { EmailMessage, EmailProvider } from "./email-provider.js";

interface SmtpEmailProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const publicHttpUrl = (value: string, field: string) => {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${field} for SMTP email template.`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Invalid ${field} for SMTP email template.`);
  return parsed.toString();
};

const renderTransactionalLayout = (input: { eyebrow: string; title: string; intro: string; bodyHtml: string; dark?: boolean }) => {
  const dark = Boolean(input.dark);
  const background = dark ? "#101318" : "#f3f5f8";
  const panel = dark ? "#171b21" : "#ffffff";
  const ink = dark ? "#f7f7f5" : "#17191d";
  const muted = dark ? "#b7bcc7" : "#626873";
  const border = dark ? "#343943" : "#e4e7ec";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:${background};font-family:Arial,sans-serif;color:${ink}"><div style="max-width:600px;margin:0 auto;padding:28px 12px"><div style="background:#1c2a41;color:#fff;padding:25px 30px;border-radius:18px 18px 0 0"><strong>PARALLAX FLOW</strong><div style="color:#d9b55f;font-size:11px;margin-top:5px;letter-spacing:1.2px">${escapeHtml(input.eyebrow)}</div></div><div style="background:${panel};padding:32px;border:1px solid ${border};border-radius:0 0 18px 18px"><h1 style="margin:0 0 12px;font-size:27px">${escapeHtml(input.title)}</h1><p style="margin:0 0 24px;color:${muted};line-height:1.6">${escapeHtml(input.intro)}</p>${input.bodyHtml}<div style="margin-top:34px;padding-top:22px;border-top:1px solid ${border};text-align:center;color:${muted};font-size:11px;line-height:18px"><p style="margin:0 0 5px">Powered by <strong>NeuralWeb Labs</strong></p><p style="margin:0">© ${new Date().getUTCFullYear()} Parallax Flow. All rights reserved.</p></div></div></div></body></html>`;
};

const renderAccountCreatedEmail = (message: EmailMessage): { subject: string; text: string; html: string } => {
  const userName = message.variables.userName?.trim() || "learner";
  const userEmail = message.variables.userEmail?.trim() || message.to;
  const createdAt = message.variables.createdAt?.trim() || "Recently";
  const academyName = message.variables.academyName?.trim() || "";
  const supportEmail = message.variables.supportEmail?.trim() || "support@parallaxflow.com";
  const currentYear = message.variables.currentYear?.trim() || String(new Date().getUTCFullYear());
  const appUrl = publicHttpUrl(message.variables.appUrl ?? "", "appUrl");
  const logoUrl = message.variables.logoUrl?.trim()
    ? publicHttpUrl(message.variables.logoUrl, "logoUrl")
    : "";

  const safe = {
    userName: escapeHtml(userName),
    userEmail: escapeHtml(userEmail),
    createdAt: escapeHtml(createdAt),
    academyName: escapeHtml(academyName),
    supportEmail: escapeHtml(supportEmail),
    currentYear: escapeHtml(currentYear),
    appUrl: escapeHtml(appUrl),
    logoUrl: escapeHtml(logoUrl),
  };
  const academyText = academyName
    ? `\nACADEMY\nYou have been successfully connected to:\n${academyName}\n\nYou can now sign in to access your Academy's courses and learning content.\n`
    : "";
  const academyHtml = academyName
    ? `<tr><td style="padding:0 32px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff8e8;border:1px solid #f2d08b;border-radius:14px"><tr><td style="padding:20px 22px"><p style="margin:0 0 8px;color:#9a6508;font-size:11px;font-weight:700;letter-spacing:1.4px">ACADEMY</p><p style="margin:0 0 7px;color:#30343b;font-size:14px;line-height:21px">You have been successfully connected to:</p><p style="margin:0;color:#15171b;font-size:18px;font-weight:700;line-height:25px">${safe.academyName}</p><p style="margin:10px 0 0;color:#5c626d;font-size:13px;line-height:20px">Sign in to access your Academy's courses and learning content.</p></td></tr></table></td></tr>`
    : "";
  const logoHtml = logoUrl
    ? `<img src="${safe.logoUrl}" width="42" height="42" alt="Parallax Flow" style="display:block;width:42px;height:42px;object-fit:contain;border:0;border-radius:8px">`
    : `<div style="width:42px;height:42px;border-radius:12px;background:#1c2a41;color:#ffffff;font-size:20px;font-weight:800;line-height:42px;text-align:center">PF</div>`;

  return {
    subject: "Welcome to Parallax Flow — Your Account Is Ready",
    text: `PARALLAX FLOW\n\nWelcome, ${userName}!\n\nYour Parallax Flow account has been successfully created. You can now sign in and start using your account.\n\nACCOUNT DETAILS\nName: ${userName}\nEmail: ${userEmail}\nAccount created: ${createdAt}\n${academyText}\nGo to Parallax Flow: ${appUrl}\n\nWHAT YOU CAN DO\nOnce you sign in, you can access the features available to your account, including your courses, learning content, practice and other available Parallax Flow features.\n\nSECURITY\nIf you did not create this account, contact Parallax Flow support immediately.\n\nNeed help? Contact ${supportEmail}.\n\nParallax Flow\nPowered by NeuralWeb Labs\n© ${currentYear} Parallax Flow. All rights reserved.`,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to Parallax Flow</title><style>@media only screen and (max-width:620px){.pf-shell{width:100%!important}.pf-pad{padding-left:20px!important;padding-right:20px!important}.pf-title{font-size:27px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background:#f3f5f8;color:#17191d;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f3f5f8"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" class="pf-shell" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e3e7ed;border-radius:20px;overflow:hidden;box-shadow:0 10px 28px rgba(28,42,65,.08)">
<tr><td class="pf-pad" style="padding:28px 32px;background:#1c2a41"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="54">${logoHtml}</td><td style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.2px">PARALLAX FLOW<div style="margin-top:4px;color:#d9b55f;font-size:10px;font-weight:700;letter-spacing:1.4px">LEARN WITH INTENT</div></td></tr></table></td></tr>
<tr><td class="pf-pad" style="padding:38px 32px 22px"><p style="margin:0 0 10px;color:#a66d0c;font-size:11px;font-weight:700;letter-spacing:1.5px">YOUR ACCOUNT IS READY</p><h1 class="pf-title" style="margin:0 0 14px;color:#111318;font-size:32px;line-height:39px;font-weight:750">Welcome, ${safe.userName} 👋</h1><p style="margin:0;color:#5c626d;font-size:16px;line-height:25px">Your Parallax Flow account has been successfully created. You can now sign in and start learning with clarity.</p></td></tr>
<tr><td class="pf-pad" style="padding:0 32px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f8fa;border:1px solid #e5e8ed;border-radius:14px"><tr><td style="padding:20px 22px"><p style="margin:0 0 14px;color:#6b7280;font-size:11px;font-weight:700;letter-spacing:1.4px">ACCOUNT DETAILS</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:0 0 12px;color:#727884;font-size:12px">Name</td><td align="right" style="padding:0 0 12px;color:#1c2027;font-size:13px;font-weight:700">${safe.userName}</td></tr><tr><td style="padding:12px 0;border-top:1px solid #e5e8ed;color:#727884;font-size:12px">Email</td><td align="right" style="padding:12px 0;border-top:1px solid #e5e8ed;color:#1c2027;font-size:13px;font-weight:700">${safe.userEmail}</td></tr><tr><td style="padding:12px 0 0;border-top:1px solid #e5e8ed;color:#727884;font-size:12px">Account created</td><td align="right" style="padding:12px 0 0;border-top:1px solid #e5e8ed;color:#1c2027;font-size:13px;font-weight:700">${safe.createdAt}</td></tr></table></td></tr></table></td></tr>
${academyHtml}
<tr><td class="pf-pad" align="center" style="padding:0 32px 34px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="#f2bd4f" style="border-radius:12px"><a href="${safe.appUrl}" target="_blank" style="display:inline-block;padding:15px 28px;color:#17191d;font-size:14px;font-weight:700;text-decoration:none;border-radius:12px">Go to Parallax Flow&nbsp; →</a></td></tr></table></td></tr>
<tr><td class="pf-pad" style="padding:28px 32px;border-top:1px solid #e9ebef"><p style="margin:0 0 8px;color:#1f232a;font-size:13px;font-weight:700;letter-spacing:.5px">WHAT YOU CAN DO</p><p style="margin:0;color:#626873;font-size:13px;line-height:21px">Access the features available to your account, including courses, learning content, practice, progress and other Parallax Flow tools.</p></td></tr>
<tr><td class="pf-pad" style="padding:0 32px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-left:3px solid #d9b55f;background:#fffaf0"><tr><td style="padding:15px 17px"><p style="margin:0 0 5px;color:#3a3d44;font-size:12px;font-weight:700">SECURITY</p><p style="margin:0;color:#6b707a;font-size:12px;line-height:19px">If you did not create this account, contact Parallax Flow support immediately. We will never ask you to share a password or verification code by email.</p></td></tr></table></td></tr>
<tr><td class="pf-pad" align="center" style="padding:24px 32px 30px;background:#f7f8fa;border-top:1px solid #e7e9ed"><p style="margin:0 0 8px;color:#606671;font-size:12px;line-height:18px">Need help? <a href="mailto:${safe.supportEmail}" style="color:#92610e;font-weight:700;text-decoration:none">${safe.supportEmail}</a></p><p style="margin:0 0 5px;color:#777d87;font-size:11px;line-height:18px">Powered by <strong>NeuralWeb Labs</strong></p><p style="margin:0;color:#979ca5;font-size:11px;line-height:18px">© ${safe.currentYear} Parallax Flow. All rights reserved.</p></td></tr>
</table></td></tr></table></body></html>`,
  };
};

export function renderEmailMessage(message: EmailMessage): { subject: string; text: string; html: string } {
  if (message.template === "account-created") return renderAccountCreatedEmail(message);
  if (message.template === "user-lifecycle") {
    const name = message.variables.userName?.trim() || "learner";
    const occurredAt = new Date(message.variables.occurredAt || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "long", timeStyle: "short" });
    const event = message.variables.event;
    const isPartialRefund = message.variables.refundType?.toLowerCase().includes("partial") ?? false;
    const descriptions: Record<string, { subject: string; title: string; intro: string; details: string[] }> = {
      REFUND_ISSUED: { subject: `${isPartialRefund ? "Partial refund" : "Full refund"} confirmed for order ${message.variables.orderNumber || ""}`.trim(), title: isPartialRefund ? "Your partial refund is confirmed" : "Your full refund is confirmed", intro: `The ${isPartialRefund ? "partial" : "full"} refund of ${message.variables.currency || "INR"} ${message.variables.amount || ""} for order ${message.variables.orderNumber || ""} has been confirmed.`, details: [`Reason: ${message.variables.reason || "Not specified"}`, `Refund type: ${message.variables.refundType || "Refund"}`] },
      ACCOUNT_DISABLED: { subject: "Your Parallax Flow account was disabled", title: "Account disabled", intro: "Your Parallax Flow account has been disabled.", details: [] },
      ACCOUNT_ENABLED: { subject: "Your Parallax Flow account was enabled", title: "Account enabled", intro: "Your Parallax Flow account has been enabled and you can sign in again.", details: [] },
      ACCOUNT_DELETED: { subject: "Your Parallax Flow account was deleted", title: "Account deleted", intro: "Your Parallax Flow account has been deleted and active sessions have been signed out.", details: [] },
      PASSWORD_CHANGED: { subject: "Your Parallax Flow password was changed", title: "Password changed", intro: "The password for your Parallax Flow account was changed successfully.", details: [] },
      EMAIL_CHANGED_OLD: { subject: "Your Parallax Flow email address was changed", title: "Email address changed", intro: `Your Parallax Flow sign-in email was changed from ${message.to} to ${message.variables.newEmail || "a new address"}.`, details: [] },
      EMAIL_CHANGED_NEW: { subject: "New email set up on Parallax Flow", title: "New email address confirmed", intro: `This email address is now set up for the Parallax Flow account previously using ${message.variables.oldEmail || "the previous address"}.`, details: [] },
      PHONE_CHANGED: { subject: "Your Parallax Flow phone number was changed", title: "Phone number changed", intro: "The phone number on your Parallax Flow account was changed successfully.", details: [`Previous number: ${message.variables.oldPhone || "Not set"}`, `New number: ${message.variables.newPhone || ""}`] },
      DEVICE_CHANGED: { subject: "Your Parallax Flow device was changed", title: "Linked device changed", intro: "The single device linked to your Parallax Flow account was changed.", details: [`Previous device: ${message.variables.oldDevice || "Unknown device"}`, `New device: ${message.variables.newDevice || "Unknown device"}`] },
    };
    const copy = descriptions[event] || { subject: "Parallax Flow account update", title: "Account update", intro: "An account change was completed.", details: [] };
    const detailText = [...copy.details, `Changed at: ${occurredAt} IST`].join("\n");
    const detailHtml = [...copy.details, `Changed at: ${occurredAt} IST`].map((line) => `<div style="padding:8px 0;border-bottom:1px solid #e4e7ec">${escapeHtml(line)}</div>`).join("");
    return {
      subject: copy.subject,
      text: `Hi ${name},\n\n${copy.intro}\n\n${detailText}\n\nIf you did not expect this change, contact Parallax Flow support immediately.\n\nPowered by NeuralWeb Labs`,
      html: renderTransactionalLayout({ eyebrow: "ACCOUNT NOTIFICATION", title: copy.title, intro: `Hi ${name}, ${copy.intro}`, bodyHtml: `<div style="padding:18px;border:1px solid #e4e7ec;border-radius:12px;line-height:1.55">${detailHtml}</div><p style="margin:22px 0 0;color:#a33;font-size:13px">If you did not expect this change, contact Parallax Flow support immediately.</p>` }),
    };
  }
  if (message.template === "purchase-invoice") {
    const v = Object.fromEntries(Object.entries(message.variables).map(([key, value]) => [key, escapeHtml(value)]));
    const itemRows = (message.variables.items || "").split("\n").filter(Boolean).map((item) => `<li style="margin:0 0 8px">${escapeHtml(item)}</li>`).join("");
    return {
      subject: `Parallax Flow receipt ${message.variables.receiptNumber}`,
      text: `Hi ${message.variables.userName},\n\nPayment received.\nOrder: ${message.variables.orderNumber}\nReceipt: ${message.variables.receiptNumber}\nItems:\n${message.variables.items}\n\nSubtotal: ${message.variables.currency} ${message.variables.subtotal}\nDiscount: ${message.variables.currency} ${message.variables.discount}\nTotal paid: ${message.variables.currency} ${message.variables.total}\n\nYour purchased learning resources are now available in your Library.\n\nPowered by NeuralWeb Labs`,
      html: `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,sans-serif;color:#17191d"><div style="max-width:600px;margin:0 auto;padding:28px 12px"><div style="background:#1c2a41;color:#fff;padding:26px 30px;border-radius:18px 18px 0 0"><strong>PARALLAX FLOW</strong><div style="color:#d9b55f;font-size:11px;margin-top:5px">PAYMENT RECEIPT</div></div><div style="background:#fff;padding:32px;border:1px solid #e4e7ec;border-radius:0 0 18px 18px"><h1 style="margin-top:0">Payment received</h1><p>Hi ${v.userName}, your purchase is complete and your resources are ready in the Library.</p><table style="width:100%;background:#f7f8fa;border-radius:12px;padding:16px"><tr><td>Order</td><td style="text-align:right;font-weight:700">${v.orderNumber}</td></tr><tr><td>Receipt</td><td style="text-align:right;font-weight:700">${v.receiptNumber}</td></tr><tr><td>Course</td><td style="text-align:right">${v.courseName}</td></tr><tr><td>Paid at</td><td style="text-align:right">${v.paidAt}</td></tr></table><h3>Items</h3><ul style="padding-left:20px">${itemRows}</ul><p>Subtotal: ${v.currency} ${v.subtotal}<br>Discount: ${v.currency} ${v.discount}</p><p style="font-size:20px;font-weight:800">Total paid: ${v.currency} ${v.total}</p><p style="margin-top:30px;color:#777;font-size:12px;text-align:center">Powered by <strong>NeuralWeb Labs</strong></p></div></div></body></html>`,
    };
  }
  if (message.template === "monthly-report-ready") {
    const userName = message.variables.userName?.trim() || "learner";
    const reportMonth = message.variables.reportMonth?.trim() || "your purchased month";
    const reportUrl = publicHttpUrl(message.variables.reportUrl ?? "", "reportUrl");
    return {
      subject: `Your Parallax Flow Monthly Report for ${reportMonth}`,
      text: `Hi ${userName},\n\nYour Monthly Report for ${reportMonth} has been generated automatically. The PDF is attached to this email and remains available securely in your Parallax Flow account.\n\nView your report: ${reportUrl}\n\nPowered by NeuralWeb Labs`,
      html: renderTransactionalLayout({
        eyebrow: "MONTHLY LEARNING REPORT",
        title: `Your ${reportMonth} report is ready`,
        intro: `Hi ${userName}, your report was generated automatically after the purchased calendar month ended.`,
        bodyHtml: `<div style="padding:18px;border:1px solid #e4e7ec;border-radius:12px;line-height:1.65"><p style="margin:0 0 16px">Your personalized performance report is attached as a PDF.</p><a href="${escapeHtml(reportUrl)}" style="display:inline-block;padding:12px 18px;background:#1c2a41;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">View in Parallax Flow</a></div>`,
      }),
    };
  }
  if (message.template === "academy-notification") {
    const name = message.variables.name?.trim() || "learner";
    const title = message.variables.title?.trim() || "Academy update";
    const body = message.variables.body?.trim() || "Your Academy has shared a new update.";
    return {
      subject: title,
      text: `Hi ${name},\n\n${title}\n\n${body}\n\nPowered by NeuralWeb Labs`,
      html: renderTransactionalLayout({
        eyebrow: "ACADEMY ANNOUNCEMENT",
        title,
        intro: `Hi ${name},`,
        bodyHtml: `<div style="padding:18px;border:1px solid #e4e7ec;border-radius:12px;line-height:1.65">${escapeHtml(body).replaceAll("\n", "<br>")}</div>`,
      }),
    };
  }
  if (message.template === "contact-submission") {
    const name = message.variables.name?.trim() || "Website visitor";
    const subject = message.variables.subject?.trim() || "New contact submission";
    const email = message.variables.email?.trim() || "Not provided";
    const phone = message.variables.phone?.trim() || "Not provided";
    const body = message.variables.message?.trim() || "No message supplied.";
    return {
      subject: `Parallax Flow contact: ${subject}`,
      text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nSubject: ${subject}\n\n${body}`,
      html: renderTransactionalLayout({
        eyebrow: "CONTACT SUBMISSION",
        title: subject,
        intro: `A new website enquiry was submitted by ${name}.`,
        bodyHtml: `<table style="width:100%;background:#f7f8fa;border-radius:12px;padding:16px"><tr><td>Name</td><td style="text-align:right;font-weight:700">${escapeHtml(name)}</td></tr><tr><td>Email</td><td style="text-align:right">${escapeHtml(email)}</td></tr><tr><td>Phone</td><td style="text-align:right">${escapeHtml(phone)}</td></tr></table><div style="margin-top:18px;padding:18px;border:1px solid #e4e7ec;border-radius:12px;line-height:1.65">${escapeHtml(body).replaceAll("\n", "<br>")}</div>`,
      }),
    };
  }
  const templates = {
    "registration-otp": { subject: "Verify your Parallax Flow email", heading: "Verify your email", copy: "use this code to continue setting up your learning account" },
    "account-email-change-otp": { subject: "Confirm your new Parallax Flow email", heading: "Confirm your new email", copy: "use this code to make this your new sign-in email" },
    "account-mobile-change-otp": { subject: "Confirm your Parallax Flow mobile number change", heading: "Confirm your mobile number change", copy: "use this code to confirm the mobile number change on your account" },
    "account-delete-otp": { subject: "Confirm Parallax Flow account deletion", heading: "Confirm account deletion", copy: "use this code only if you requested permanent account deactivation" },
  } as const;
  const template = templates[message.template as keyof typeof templates];
  if (!template) {
    throw new Error(`Unsupported SMTP email template: ${message.template}.`);
  }

  const name = message.variables.name?.trim() || "learner";
  const code = message.variables.code ?? "";
  const expiresInMinutes = message.variables.expiresInMinutes ?? "15";
  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(code);
  const safeExpiry = escapeHtml(expiresInMinutes);

  return {
    subject: template.subject,
    text: `Hi ${name},\n\nYour Parallax Flow verification code is ${code}. It expires in ${expiresInMinutes} minutes. Use it to ${template.copy}.\n\nIf you did not request this, you can ignore this email.\n\nPowered by NeuralWeb Labs`,
    html: `<!doctype html><html><body style="margin:0;background:#101318;color:#f7f7f5;font-family:Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:40px 24px"><p style="color:#f0ba58;font-size:12px;font-weight:700;letter-spacing:1.5px">PARALLAX FLOW</p><h1 style="font-size:26px;margin:18px 0 8px">${template.heading}</h1><p style="color:#b7bcc7;line-height:1.6">Hi ${safeName}, ${template.copy}.</p><div style="margin:28px 0;padding:22px;border:1px solid #343943;border-radius:18px;background:#171b21;text-align:center"><div style="font-size:38px;font-weight:800;letter-spacing:12px;color:#f0ba58">${safeCode}</div></div><p style="color:#b7bcc7">This code expires in ${safeExpiry} minutes. Never share it with anyone.</p><p style="margin-top:34px;color:#747b86;font-size:11px;text-align:center">Powered by <strong>NeuralWeb Labs</strong></p></div></body></html>`,
  };
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: SmtpEmailProviderConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const rendered = renderEmailMessage(message);
    const result = await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.fileName,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.contentBase64, "base64"),
      })),
      headers: { "X-Idempotency-Key": message.idempotencyKey },
    });
    return { providerMessageId: result.messageId };
  }
}
