import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmailMessage } from "../integrations/smtp-email-provider.js";

test("registration OTP email renders the code and escapes user content", () => {
  const rendered = renderEmailMessage({
    to: "learner@example.test",
    template: "registration-otp",
    variables: { name: "Learner <script>", code: "4821", expiresInMinutes: "15" },
    idempotencyKey: "registration:test:email",
  });

  assert.match(rendered.subject, /Verify/);
  assert.match(rendered.text, /4821/);
  assert.match(rendered.html, /4821/);
  assert.doesNotMatch(rendered.html, /Learner <script>/);
  assert.match(rendered.html, /Learner &lt;script&gt;/);
});

test("SMTP renderer rejects unknown templates", () => {
  assert.throws(() => renderEmailMessage({
    to: "learner@example.test",
    template: "unknown-template",
    variables: {},
    idempotencyKey: "unknown:test",
  }), /Unsupported SMTP email template/);
});

test("SMTP renderer supports security-sensitive account verification templates", () => {
  const emailChange = renderEmailMessage({ to: "new@example.com", template: "account-email-change-otp", variables: { name: "Learner", code: "1234", expiresInMinutes: "15" }, idempotencyKey: "email-change" });
  assert.match(emailChange.subject, /new Parallax Flow email/i);
  assert.match(emailChange.text, /1234/);
  const mobileChange = renderEmailMessage({ to: "current@example.com", template: "account-mobile-change-otp", variables: { name: "Learner", code: "2468", expiresInMinutes: "15" }, idempotencyKey: "mobile-change" });
  assert.match(mobileChange.subject, /mobile number change/i);
  assert.match(mobileChange.text, /2468/);
  const deletion = renderEmailMessage({ to: "user@example.com", template: "account-delete-otp", variables: { name: "Learner", code: "4321", expiresInMinutes: "15" }, idempotencyKey: "delete" });
  assert.match(deletion.subject, /deletion/i);
  assert.match(deletion.html, /4321/);
});

test("SMTP renderer supports escaped Academy announcements and contact submissions", () => {
  const announcement = renderEmailMessage({
    to: "learner@example.test",
    template: "academy-notification",
    variables: { name: "Learner <One>", title: "Schedule update", body: "Class starts at 9.\nBring notes." },
    idempotencyKey: "announcement:test",
  });
  assert.match(announcement.subject, /Schedule update/);
  assert.match(announcement.html, /Learner &lt;One&gt;/);
  assert.match(announcement.html, /Powered by <strong[^>]*>NeuralWeb Labs/);
  assert.match(announcement.html, /href="http:\/\/neuralweblabs\.com\/"/);

  const contact = renderEmailMessage({
    to: "support@example.test",
    template: "contact-submission",
    variables: { name: "Visitor", email: "visitor@example.test", phone: "+91 90000 00000", subject: "Course <query>", message: "Please call me." },
    idempotencyKey: "contact:test",
  });
  assert.match(contact.subject, /Course <query>/);
  assert.match(contact.html, /Course &lt;query&gt;/);
  assert.doesNotMatch(contact.html, /<query>/);
});

test("account-created email is branded, responsive, Academy-aware and HTML-safe", () => {
  const rendered = renderEmailMessage({
    to: "learner@example.test",
    template: "account-created",
    variables: {
      userName: "Learner <script>alert(1)</script>",
      userEmail: "learner@example.test",
      createdAt: "August 29, 2026 at 10:30 AM UTC",
      academyName: "Phase 4 <Academy>",
      appUrl: "https://app.parallaxflow.example/",
      logoUrl: "https://app.parallaxflow.example/logo.png",
      supportEmail: "support@parallaxflow.example",
      currentYear: "2026",
      password: "must-never-render",
      accessToken: "must-never-render-either",
    },
    idempotencyKey: "account-created:learner",
  });

  assert.equal(rendered.subject, "Welcome to Parallax Flow — Your Account Is Ready");
  assert.match(rendered.html, /Phase 4 &lt;Academy&gt;/);
  assert.match(rendered.html, /app\.parallaxflow\.example\/logo\.png/);
  assert.match(rendered.html, /@media only screen/);
  assert.doesNotMatch(rendered.html, /<script>alert/);
  assert.doesNotMatch(rendered.html, /must-never-render/);
  assert.doesNotMatch(rendered.text, /must-never-render/);
});

test("account-created email omits the Academy section when no Academy is associated", () => {
  const rendered = renderEmailMessage({
    to: "learner@example.test",
    template: "account-created",
    variables: {
      userName: "Learner",
      userEmail: "learner@example.test",
      createdAt: "August 29, 2026 at 10:30 AM UTC",
      academyName: "",
      appUrl: "https://app.parallaxflow.example/",
      logoUrl: "https://app.parallaxflow.example/logo.png",
      supportEmail: "support@parallaxflow.example",
      currentYear: "2026",
    },
    idempotencyKey: "account-created:learner",
  });

  assert.doesNotMatch(rendered.html, />ACADEMY</);
  assert.doesNotMatch(rendered.text, /\nACADEMY\n/);
});

test("monthly report email identifies the report month and attachment delivery", () => {
  const rendered = renderEmailMessage({
    to: "learner@example.test",
    template: "monthly-report-ready",
    variables: {
      userName: "Learner <One>",
      reportMonth: "May 2025",
      reportUrl: "https://app.parallaxflow.example/monthly-report",
    },
    idempotencyKey: "monthly-report-email:report-1:v1",
  });

  assert.match(rendered.subject, /May 2025/);
  assert.match(rendered.text, /attached to this email/);
  assert.match(rendered.html, /Learner &lt;One&gt;/);
  assert.match(rendered.html, /View in Parallax Flow/);
  assert.doesNotMatch(rendered.html, /Learner <One>/);
});

test("lifecycle emails include refund and old-to-new security details safely", () => {
  const refund = renderEmailMessage({
    to: "learner@example.test",
    template: "user-lifecycle",
    variables: { userName: "Learner", event: "REFUND_ISSUED", occurredAt: "2026-09-13T12:00:00.000Z", amount: "125.00", currency: "INR", orderNumber: "PF-100", reason: "Duplicate <charge>", refundType: "Partial refund" },
    idempotencyKey: "refund:test",
  });
  assert.match(refund.subject, /PF-100/);
  assert.match(refund.subject, /Partial refund/);
  assert.match(refund.text, /partial refund/i);
  assert.match(refund.text, /INR 125\.00/);
  assert.match(refund.text, /Duplicate <charge>/);
  assert.match(refund.html, /Duplicate &lt;charge&gt;/);
  assert.doesNotMatch(refund.html, /Duplicate <charge>/);

  const device = renderEmailMessage({
    to: "learner@example.test",
    template: "user-lifecycle",
    variables: { userName: "Learner", event: "DEVICE_CHANGED", occurredAt: "2026-09-13T12:00:00.000Z", oldDevice: "Old phone / ANDROID", newDevice: "New phone / IOS" },
    idempotencyKey: "device:test",
  });
  assert.match(device.text, /Old phone \/ ANDROID/);
  assert.match(device.text, /New phone \/ IOS/);
});

test("purchase receipt email uses the premium responsive receipt and linked branding", () => {
  const rendered = renderEmailMessage({
    to: "learner@example.test",
    template: "purchase-invoice",
    variables: {
      userName: "Learner <One>",
      orderNumber: "PF-20260917-ABC",
      receiptNumber: "RCP-20260917-XYZ",
      paidAt: "2026-09-17T15:00:22.891Z",
      courseName: "Class 12",
      currency: "INR",
      subtotal: "600.00",
      discount: "120.00",
      total: "480.00",
      items: "Premium note × 1 — INR 600.00",
    },
    idempotencyKey: "purchase:test",
  });

  assert.match(rendered.html, /OFFICIAL PAYMENT RECEIPT/);
  assert.match(rendered.html, /Coupon discount/);
  assert.match(rendered.html, /INR 480\.00/);
  assert.match(rendered.html, /href="http:\/\/neuralweblabs\.com\/"/);
  assert.match(rendered.html, /Learner &lt;One&gt;/);
  assert.doesNotMatch(rendered.html, /Learner <One>/);
});

test("account lifecycle messages are standalone and contain no generated collapsed-content markup", () => {
  const disabled = renderEmailMessage({
    to: "learner@example.test",
    template: "user-lifecycle",
    variables: { userName: "Learner", event: "ACCOUNT_DISABLED", occurredAt: "2026-09-17T17:15:00.000Z" },
    idempotencyKey: "disabled:test",
  });
  const enabled = renderEmailMessage({
    to: "learner@example.test",
    template: "user-lifecycle",
    variables: { userName: "Learner", event: "ACCOUNT_ENABLED", occurredAt: "2026-09-17T17:20:00.000Z" },
    idempotencyKey: "enabled:test",
  });

  assert.notEqual(disabled.subject, enabled.subject);
  for (const rendered of [disabled, enabled]) {
    assert.doesNotMatch(rendered.html, /\.\.\.|&hellip;|<blockquote|gmail_quote|display\s*:\s*none|visibility\s*:\s*hidden/i);
    assert.match(rendered.html, /ACCOUNT NOTIFICATION/);
    assert.match(rendered.html, /Changed at:/);
    assert.match(rendered.html, /Powered by <strong[^>]*>NeuralWeb Labs/);
    assert.ok(Buffer.byteLength(rendered.html, "utf8") < 102_400);
  }
});
