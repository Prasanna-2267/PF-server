import { prisma } from "../db/prisma.js";
import { runLearnerReminderSweep } from "../services/learnerNotificationService.js";
import { processMonthlyReportsFor1stOfMonth } from "../services/monthlyReportService.js";

try {
  await prisma.$connect();
  const reminders = await runLearnerReminderSweep();
  const monthlyReports = await processMonthlyReportsFor1stOfMonth();
  console.log(JSON.stringify({ reminders, monthlyReports }));
} finally {
  await prisma.$disconnect();
}
