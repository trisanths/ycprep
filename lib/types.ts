import type { QuestionType } from "@/data/questions";

export type GradeSource = "azure" | "heuristic";

export type GradeMetrics = {
  clarity: number;
  specificity: number;
  userInsight: number;
  defensibility: number;
  brevity: number;
};

export type GradeResult = {
  overall: number;
  metrics: GradeMetrics;
  strengths: string[];
  improvements: string[];
  sharperAnswer: string;
  followUpQuestion: string;
  summary: string;
  source: GradeSource;
  warning?: string;
};

export type GradingStatus = "pending" | "graded" | "failed";

export type PracticeAttempt = {
  id: string;
  questionId: string;
  questionText: string;
  questionType: QuestionType;
  answer: string;
  elapsedMs: number;
  createdAt: string;
  wordCount: number;
  gradingStatus: GradingStatus;
  grade?: GradeResult;
  error?: string;
  audioId?: string;
  audioMimeType?: string;
};
