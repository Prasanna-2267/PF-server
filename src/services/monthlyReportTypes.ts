export type ReportDelta = {
  value: number;
  unit: "COUNT" | "PERCENTAGE_POINTS" | "HOURS";
  direction: "UP" | "DOWN" | "SAME";
};

export type MonthlyReportSnapshot = {
  schemaVersion: 2;
  algorithmVersion: string;
  generatedFor: { userId: string; fullName: string; courseId: string; courseCode: string; courseName: string; timezone: string };
  period: { yearMonth: string; label: string; previousYearMonth: string; previousLabel: string; start: string; endExclusive: string };
  header: { studyStreakDays: number; monthlyGoalPercent: number; previousDataAvailable: boolean };
  summary: {
    mcqsAttempted: number;
    mcqsCorrect: number;
    accuracyPercent: number | null;
    conceptsCompleted: number;
    studyHours: number;
    testsTaken: number;
    deltas: Record<"mcqsAttempted" | "mcqsCorrect" | "accuracyPercent" | "conceptsCompleted" | "studyHours" | "testsTaken", ReportDelta | null>;
  };
  monthlyTrend: Array<{ yearMonth: string; label: string; attempted: number; correct: number; accuracyPercent: number | null }>;
  weeklyAccuracy: Array<{ label: string; attempted: number; accuracyPercent: number | null }>;
  subjectPerformance: Array<{ subjectId: string; name: string; attempted: number; currentAccuracy: number | null; previousAccuracy: number | null; changePoints: number | null }>;
  conceptCompletion: { completed: number; inProgress: number; notStarted: number; total: number };
  strengths: Array<{ name: string; accuracyPercent: number; attempted: number }>;
  weakAreas: Array<{ name: string; accuracyPercent: number; attempted: number }>;
  practiceDistribution: Array<{ label: "Easy" | "Medium" | "Hard"; count: number; percent: number }>;
  consistency: Array<{ date: string; weekday: number; week: number; studySeconds: number; intensity: number }>;
  testPerformance: {
    available: boolean;
    testsTaken: number;
    averageScore: number | null;
    best: { title: string; score: number } | null;
    lowest: { title: string; score: number } | null;
    trend: Array<{ label: string; score: number }>;
  };
  overallProgress: {
    syllabusPercent: number;
    previousSyllabusPercent: number | null;
    changePoints: number | null;
    messageTitle: string;
    messageBody: string;
    rank: null;
  };
  audit: { sourceDataHash: string; generatedAt: string };
};
