import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont, type RGB } from "pdf-lib";
import type { MonthlyReportSnapshot, ReportDelta } from "./monthlyReportTypes.js";

const PAGE_W = 1024;
const PAGE_H = 1536;
const C = {
  background: rgb(0.965, 0.976, 0.992),
  paper: rgb(1, 1, 1),
  ink: rgb(0.035, 0.095, 0.19),
  muted: rgb(0.36, 0.42, 0.51),
  line: rgb(0.84, 0.88, 0.93),
  blue: rgb(0.12, 0.45, 0.88),
  blueSoft: rgb(0.91, 0.95, 1),
  green: rgb(0.16, 0.68, 0.4),
  amber: rgb(0.97, 0.63, 0.12),
  red: rgb(0.9, 0.27, 0.25),
  grey: rgb(0.69, 0.73, 0.79),
};

type Fonts = { regular: PDFFont; bold: PDFFont };

const round = (value: number, digits = 0) => Number(value.toFixed(digits));
const safe = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 3))}...`;

function text(page: PDFPage, fonts: Fonts, value: string, x: number, y: number, size = 10, color = C.ink, bold = false, maxWidth?: number) {
  let output = value;
  if (maxWidth) {
    while (output.length > 3 && (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(output, size) > maxWidth) output = `${output.slice(0, -4)}...`;
  }
  page.drawText(output, { x, y, size, font: bold ? fonts.bold : fonts.regular, color });
}

function card(page: PDFPage, x: number, y: number, width: number, height: number, fill = C.paper, border = C.line) {
  page.drawRectangle({ x, y, width, height, color: fill, borderColor: border, borderWidth: 1 });
}

function sectionTitle(page: PDFPage, fonts: Fonts, number: number, title: string, x: number, y: number, suffix?: string) {
  text(page, fonts, `${number}. ${title}`, x, y, 14, C.ink, true);
  if (suffix) text(page, fonts, suffix, x + 310, y + 1, 8, C.muted, false, 170);
}

function deltaLabel(delta: ReportDelta | null) {
  if (!delta) return "No previous data";
  const sign = delta.value > 0 ? "+" : "";
  const suffix = delta.unit === "HOURS" ? " hrs" : delta.unit === "PERCENTAGE_POINTS" ? " pts" : "";
  return `${sign}${round(delta.value, delta.unit === "HOURS" ? 1 : 0)}${suffix}`;
}

function deltaColor(delta: ReportDelta | null) {
  if (!delta || delta.direction === "SAME") return C.muted;
  return delta.direction === "UP" ? C.green : C.red;
}

function lineChart(page: PDFPage, values: Array<number | null>, x: number, y: number, width: number, height: number, color: RGB) {
  const present = values.filter((value): value is number => value !== null);
  const max = Math.max(1, ...present);
  const min = Math.min(0, ...present);
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 1, color: C.line });
  let previous: { x: number; y: number } | null = null;
  values.forEach((value, index) => {
    if (value === null) { previous = null; return; }
    const px = x + (values.length <= 1 ? width / 2 : index * width / (values.length - 1));
    const py = y + ((value - min) / Math.max(1, max - min)) * height;
    if (previous) page.drawLine({ start: previous, end: { x: px, y: py }, thickness: 2, color });
    page.drawCircle({ x: px, y: py, size: 3.5, color, borderColor: C.paper, borderWidth: 1 });
    previous = { x: px, y: py };
  });
}

function donut(page: PDFPage, values: Array<{ value: number; color: RGB }>, x: number, y: number, radius: number) {
  const total = values.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    page.drawCircle({ x, y, size: radius, color: C.blueSoft });
    page.drawCircle({ x, y, size: radius * 0.54, color: C.paper });
    return;
  }
  let start = -Math.PI / 2;
  for (const item of values) {
    if (!item.value) continue;
    const angle = Math.max(0.015, item.value / total * Math.PI * 2);
    const steps = Math.max(4, Math.ceil(angle / 0.16));
    const outer: Array<[number, number]> = [];
    const inner: Array<[number, number]> = [];
    for (let index = 0; index <= steps; index += 1) {
      const current = start + angle * index / steps;
      outer.push([x + Math.cos(current) * radius, y + Math.sin(current) * radius]);
      inner.unshift([x + Math.cos(current) * radius * 0.57, y + Math.sin(current) * radius * 0.57]);
    }
    const points = [...outer, ...inner];
    const path = points.map(([px, py], index) => `${index ? "L" : "M"} ${px.toFixed(2)} ${py.toFixed(2)}`).join(" ") + " Z";
    page.drawSvgPath(path, { color: item.color });
    start += angle;
  }
}

function metric(page: PDFPage, fonts: Fonts, x: number, y: number, width: number, label: string, value: string, delta: ReportDelta | null) {
  card(page, x, y, width, 78);
  text(page, fonts, label, x + 12, y + 55, 8, C.muted);
  text(page, fonts, value, x + 12, y + 30, 18, C.ink, true, width - 24);
  text(page, fonts, deltaLabel(delta), x + 12, y + 12, 7.5, deltaColor(delta), true, width - 24);
}

export async function generateMonthlyReportPdf(snapshot: MonthlyReportSnapshot) {
  const document = await PDFDocument.create();
  document.setTitle(`Monthly Report - ${snapshot.period.label}`);
  document.setAuthor("Parallax Flow");
  document.setSubject(`${snapshot.generatedFor.fullName} - ${snapshot.generatedFor.courseName}`);
  document.setCreator(`Parallax Flow ${snapshot.algorithmVersion}`);
  document.setProducer("Parallax Flow Report Service");
  document.setCreationDate(new Date(snapshot.audit.generatedAt));
  document.setModificationDate(new Date(snapshot.audit.generatedAt));
  const fonts: Fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  };
  const page = document.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: C.background });
  card(page, 14, 16, PAGE_W - 28, PAGE_H - 32);

  // Header and learner identity.
  card(page, 30, 1435, 964, 78, C.paper);
  page.drawRectangle({ x: 44, y: 1450, width: 46, height: 46, color: C.blue });
  text(page, fonts, "MR", 57, 1464, 15, C.paper, true);
  text(page, fonts, "Monthly Report", 104, 1480, 24, C.ink, true);
  text(page, fonts, `Generated ${new Date(snapshot.audit.generatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: snapshot.generatedFor.timezone })}`, 104, 1458, 9, C.muted);
  text(page, fonts, snapshot.period.label, 838, 1477, 15, C.ink, true, 120);
  text(page, fonts, "Completed month", 838, 1459, 8, C.muted);

  card(page, 30, 1337, 964, 86, C.paper);
  page.drawCircle({ x: 72, y: 1380, size: 29, color: C.blueSoft });
  const initials = snapshot.generatedFor.fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "PF";
  text(page, fonts, initials, 57, 1372, 18, C.ink, true);
  text(page, fonts, safe(snapshot.generatedFor.fullName, 30), 112, 1387, 16, C.ink, true, 180);
  text(page, fonts, safe(snapshot.generatedFor.courseName, 34), 112, 1367, 9, C.muted, false, 180);
  const headerCols = [
    ["Report for", snapshot.period.label],
    ["Compared with", snapshot.header.previousDataAvailable ? snapshot.period.previousLabel : "No prior activity"],
    ["Study streak", `${snapshot.header.studyStreakDays} days`],
    ["Monthly goal", `${snapshot.header.monthlyGoalPercent}% achieved`],
  ];
  headerCols.forEach(([label, value], index) => {
    const x = 320 + index * 164;
    if (index) page.drawLine({ start: { x: x - 14, y: 1353 }, end: { x: x - 14, y: 1408 }, color: C.line, thickness: 1 });
    text(page, fonts, label, x, 1395, 8, C.muted);
    text(page, fonts, safe(value, 22), x, 1369, index >= 2 ? 17 : 12, index === 2 ? C.green : index === 3 ? C.blue : C.ink, true, 145);
  });

  // 1. Overall summary.
  card(page, 30, 1194, 964, 126, rgb(0.986, 0.991, 1));
  sectionTitle(page, fonts, 1, "Overall Summary", 44, 1294, snapshot.header.previousDataAvailable ? `vs ${snapshot.period.previousLabel}` : "No previous-month data");
  const summary = snapshot.summary;
  const summaryMetrics: Array<[string, string, ReportDelta | null]> = [
    ["MCQs Attempted", String(summary.mcqsAttempted), summary.deltas.mcqsAttempted],
    ["MCQs Correct", String(summary.mcqsCorrect), summary.deltas.mcqsCorrect],
    ["Accuracy", summary.accuracyPercent === null ? "N/A" : `${summary.accuracyPercent}%`, summary.deltas.accuracyPercent],
    ["Concepts Completed", String(summary.conceptsCompleted), summary.deltas.conceptsCompleted],
    ["Study Hours", `${summary.studyHours} hrs`, summary.deltas.studyHours],
    ["Tests Taken", String(summary.testsTaken), summary.deltas.testsTaken],
  ];
  summaryMetrics.forEach(([label, value, delta], index) => metric(page, fonts, 44 + index * 157, 1206, 143, label, value, delta));

  // 2 + 3 charts.
  card(page, 30, 930, 477, 248);
  sectionTitle(page, fonts, 2, "MCQ Performance Trend", 44, 1150);
  text(page, fonts, "Attempted", 48, 1128, 8, C.blue, true);
  text(page, fonts, "Correct", 110, 1128, 8, C.green, true);
  text(page, fonts, "Accuracy", 162, 1128, 8, C.amber, true);
  const trend = snapshot.monthlyTrend;
  const maxAttempts = Math.max(1, ...trend.map((item) => item.attempted));
  trend.forEach((item, index) => {
    const groupX = 58 + index * 69;
    page.drawRectangle({ x: groupX, y: 972, width: 14, height: item.attempted / maxAttempts * 122, color: C.blue });
    page.drawRectangle({ x: groupX + 17, y: 972, width: 14, height: item.correct / maxAttempts * 122, color: C.green });
    text(page, fonts, item.label, groupX - 3, 952, 7, C.muted, false, 58);
  });
  lineChart(page, trend.map((item) => item.accuracyPercent), 62, 982, 384, 92, C.amber);

  card(page, 517, 930, 477, 248);
  sectionTitle(page, fonts, 3, "Accuracy Trend (%)", 531, 1150);
  for (let line = 0; line <= 4; line += 1) page.drawLine({ start: { x: 552, y: 978 + line * 31 }, end: { x: 957, y: 978 + line * 31 }, color: C.line, thickness: 0.7 });
  lineChart(page, snapshot.weeklyAccuracy.map((item) => item.accuracyPercent), 565, 992, 372, 105, C.blue);
  snapshot.weeklyAccuracy.forEach((item, index) => text(page, fonts, item.label, 550 + index * 82, 952, 7, C.muted, false, 58));

  // 4 + 5 subject and concepts.
  card(page, 30, 686, 477, 228);
  sectionTitle(page, fonts, 4, "Subject-wise Performance", 44, 886);
  const subjects = snapshot.subjectPerformance.slice(0, 6);
  if (!subjects.length) text(page, fonts, "Not enough subject activity yet.", 54, 832, 10, C.muted);
  subjects.forEach((item, index) => {
    const rowY = 842 - index * 27;
    text(page, fonts, safe(item.name, 19), 48, rowY, 8.5, C.ink, true, 125);
    page.drawRectangle({ x: 180, y: rowY - 1, width: 210, height: 7, color: C.blueSoft });
    page.drawRectangle({ x: 180, y: rowY - 1, width: 210 * (item.currentAccuracy ?? 0) / 100, height: 7, color: C.blue });
    text(page, fonts, item.currentAccuracy === null ? "N/A" : `${item.currentAccuracy}%`, 400, rowY - 2, 8, C.ink, true);
    const change = item.changePoints;
    text(page, fonts, change === null ? "-" : `${change > 0 ? "+" : ""}${change}`, 450, rowY - 2, 8, change === null ? C.muted : change >= 0 ? C.green : C.red, true);
  });

  card(page, 517, 686, 477, 228);
  sectionTitle(page, fonts, 5, "Concept Completion", 531, 886);
  const completion = snapshot.conceptCompletion;
  donut(page, [
    { value: completion.completed, color: C.green },
    { value: completion.inProgress, color: C.blue },
    { value: completion.notStarted, color: C.amber },
  ], 650, 786, 75);
  text(page, fonts, String(completion.total), 628, 781, 19, C.ink, true);
  text(page, fonts, "Concepts", 626, 765, 7, C.muted);
  [["Completed", completion.completed, C.green], ["In Progress", completion.inProgress, C.blue], ["Not Started", completion.notStarted, C.amber]].forEach(([label, value, color], index) => {
    page.drawRectangle({ x: 755, y: 824 - index * 39, width: 10, height: 10, color: color as RGB });
    text(page, fonts, String(label), 776, 824 - index * 39, 9, C.ink);
    text(page, fonts, `${value}`, 915, 824 - index * 39, 9, C.muted, true);
  });

  // 6 + 7 strengths and distribution.
  card(page, 30, 494, 590, 176);
  sectionTitle(page, fonts, 6, "Top Strengths & Weak Areas", 44, 642, "by accuracy");
  text(page, fonts, "Top Strengths", 48, 616, 9, C.green, true);
  text(page, fonts, "Weak Areas", 338, 616, 9, C.red, true);
  const areaRow = (items: MonthlyReportSnapshot["strengths"], x: number, color: RGB) => {
    if (!items.length) text(page, fonts, "Not enough activity", x, 580, 9, C.muted);
    items.slice(0, 3).forEach((item, index) => {
      const y = 584 - index * 31;
      page.drawCircle({ x: x + 6, y: y + 4, size: 6, color });
      text(page, fonts, safe(item.name, 24), x + 20, y, 8.5, C.ink, false, 185);
      text(page, fonts, `${item.accuracyPercent}%`, x + 222, y, 8.5, C.ink, true);
    });
  };
  areaRow(snapshot.strengths, 48, C.green);
  areaRow(snapshot.weakAreas, 338, C.red);

  card(page, 630, 494, 364, 176);
  sectionTitle(page, fonts, 7, "Practice Distribution", 644, 642);
  donut(page, snapshot.practiceDistribution.map((item, index) => ({ value: item.count, color: [C.green, C.blue, C.red][index] })), 724, 561, 55);
  snapshot.practiceDistribution.forEach((item, index) => {
    const y = 592 - index * 31;
    page.drawRectangle({ x: 803, y, width: 9, height: 9, color: [C.green, C.blue, C.red][index] });
    text(page, fonts, item.label, 822, y, 8.5, C.ink);
    text(page, fonts, `${item.percent}%`, 930, y, 8.5, C.muted, true);
  });

  // 8 + 9 consistency and tests.
  card(page, 30, 250, 350, 228);
  sectionTitle(page, fonts, 8, "Study Consistency", 44, 450);
  const heat = snapshot.consistency;
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    text(page, fonts, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekday - 1], 48, 413 - (weekday - 1) * 22, 7, C.muted);
    for (let week = 0; week < 5; week += 1) {
      const item = heat.find((entry) => entry.weekday === weekday && entry.week === week);
      const intensity = item?.intensity ?? 0;
      const fill = intensity === 0 ? rgb(0.91, 0.95, 0.93) : intensity === 1 ? rgb(0.72, 0.9, 0.79) : intensity === 2 ? rgb(0.45, 0.79, 0.59) : intensity === 3 ? rgb(0.25, 0.68, 0.43) : rgb(0.1, 0.55, 0.32);
      page.drawRectangle({ x: 95 + week * 45, y: 406 - (weekday - 1) * 22, width: 34, height: 14, color: fill });
    }
  }
  text(page, fonts, "Less", 99, 269, 7, C.muted);
  [0, 1, 2, 3, 4].forEach((intensity) => page.drawRectangle({ x: 133 + intensity * 15, y: 267, width: 11, height: 11, color: intensity === 0 ? rgb(0.91, 0.95, 0.93) : intensity === 1 ? rgb(0.72, 0.9, 0.79) : intensity === 2 ? rgb(0.45, 0.79, 0.59) : intensity === 3 ? rgb(0.25, 0.68, 0.43) : rgb(0.1, 0.55, 0.32) }));
  text(page, fonts, "More", 213, 269, 7, C.muted);

  card(page, 390, 250, 604, 228);
  sectionTitle(page, fonts, 9, "Test Performance", 404, 450);
  const tests = snapshot.testPerformance;
  if (!tests.available) {
    text(page, fonts, "Not enough completed mock-test activity for this month.", 420, 356, 11, C.muted);
  } else {
    const testMetrics = [
      ["Tests Taken", String(tests.testsTaken)],
      ["Average Score", `${tests.averageScore}%`],
      ["Best Score", tests.best ? `${tests.best.score}%` : "N/A"],
      ["Lowest Score", tests.lowest ? `${tests.lowest.score}%` : "N/A"],
    ];
    testMetrics.forEach(([label, value], index) => {
      const x = 410 + index * 141;
      card(page, x, 367, 127, 58, rgb(0.986, 0.991, 1));
      text(page, fonts, label, x + 9, 404, 7, C.muted);
      text(page, fonts, value, x + 9, 381, 15, C.ink, true, 105);
    });
    lineChart(page, tests.trend.map((item) => item.score), 430, 288, 515, 55, C.blue);
    tests.trend.slice(0, 8).forEach((item, index) => text(page, fonts, item.label, 420 + index * 68, 271, 6.5, C.muted, false, 55));
  }

  // 10. Overall progress.
  card(page, 30, 70, 964, 164);
  sectionTitle(page, fonts, 10, "Overall Progress", 44, 206);
  text(page, fonts, "Syllabus Completion", 56, 170, 9, C.muted);
  text(page, fonts, `${snapshot.overallProgress.syllabusPercent}%`, 56, 132, 31, C.ink, true);
  if (snapshot.overallProgress.changePoints !== null) text(page, fonts, `${snapshot.overallProgress.changePoints >= 0 ? "+" : ""}${snapshot.overallProgress.changePoints} pts`, 132, 137, 9, snapshot.overallProgress.changePoints >= 0 ? C.green : C.red, true);
  page.drawRectangle({ x: 56, y: 102, width: 330, height: 11, color: C.blueSoft });
  page.drawRectangle({ x: 56, y: 102, width: 330 * snapshot.overallProgress.syllabusPercent / 100, height: 11, color: C.blue });
  page.drawLine({ start: { x: 425, y: 90 }, end: { x: 425, y: 183 }, color: C.line, thickness: 1 });
  text(page, fonts, snapshot.overallProgress.messageTitle, 454, 163, 14, C.green, true, 450);
  text(page, fonts, snapshot.overallProgress.messageBody, 454, 136, 9, C.ink, false, 490);
  text(page, fonts, "Rank unavailable until a reliable comparable batch is available.", 454, 105, 8, C.muted, false, 490);

  text(page, fonts, `Comparisons use ${snapshot.period.previousLabel}. Values are calculated from stored learner activity in ${snapshot.generatedFor.timezone}.`, 32, 42, 7, C.muted);
  text(page, fonts, `Report integrity ${snapshot.audit.sourceDataHash.slice(0, 12)}`, 808, 42, 7, C.muted, false, 175);

  return Buffer.from(await document.save({ useObjectStreams: true, addDefaultPage: false }));
}
