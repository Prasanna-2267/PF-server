import { renderEmailMessage } from "../integrations/smtp-email-provider.js";

const requireEnvironmentValue = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured to render the email preview.`);
  return value;
};

const rendered = renderEmailMessage({
  to: "preview@example.test",
  template: "account-created",
  variables: {
    userName: "Preview Learner",
    userEmail: "preview@example.test",
    createdAt: "August 29, 2026 at 10:30 AM UTC",
    academyName: "Phase 4 Academy",
    appUrl: requireEnvironmentValue("PUBLIC_APP_URL"),
    logoUrl: requireEnvironmentValue("EMAIL_LOGO_URL"),
    supportEmail: requireEnvironmentValue("SUPPORT_EMAIL"),
    currentYear: "2026",
  },
  idempotencyKey: "preview-only",
});

process.stdout.write(rendered.html);
