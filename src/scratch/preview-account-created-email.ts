import { renderEmailMessage } from "../integrations/smtp-email-provider.js";

const rendered = renderEmailMessage({
  to: "preview@example.test",
  template: "account-created",
  variables: {
    userName: "Preview Learner",
    userEmail: "preview@example.test",
    createdAt: "August 29, 2026 at 10:30 AM UTC",
    academyName: "Phase 4 Academy",
    appUrl: "https://example.test/",
    logoUrl: "https://example.test/logo.png",
    supportEmail: "support@example.test",
    currentYear: "2026",
  },
  idempotencyKey: "preview-only",
});

process.stdout.write(rendered.html);
