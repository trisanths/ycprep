import { NextResponse } from "next/server";
import type { QuestionType } from "@/data/questions";
import type { GradeMetrics, GradeResult } from "@/lib/types";

export const runtime = "nodejs";

type GradeRequest = {
  question: string;
  questionType: QuestionType;
  answer: string;
  elapsedMs: number;
  startupContext?: string;
};

type AzureTarget = {
  api: "chat-completions" | "responses";
  url: string;
  auth: "api-key" | "bearer";
  includeModel: boolean;
  model?: string;
};

const metricKeys: Array<keyof GradeMetrics> = [
  "clarity",
  "specificity",
  "userInsight",
  "defensibility",
  "brevity"
];

export async function POST(request: Request) {
  let payload: GradeRequest;

  try {
    payload = (await request.json()) as GradeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!payload.question || !payload.answer?.trim()) {
    return NextResponse.json({ error: "A question and answer are required." }, { status: 400 });
  }

  const fallback = heuristicGrade(payload);
  let target: AzureTarget | null;

  try {
    target = resolveAzureTarget();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Azure is not configured correctly.";
    return NextResponse.json({
      grade: {
        ...fallback,
        warning: `${message} This was graded with the local rubric.`
      }
    });
  }

  if (!target) {
    return NextResponse.json({
      grade: {
        ...fallback,
        warning: "Azure AI is not configured yet, so this was graded with the local rubric."
      }
    });
  }

  try {
    const grade = await gradeWithAzure(payload, target);
    return NextResponse.json({ grade });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Azure grading failed.";
    return NextResponse.json({ error: `Azure grading failed: ${message}` }, { status: 502 });
  }
}

function resolveAzureTarget(): AzureTarget | null {
  const endpoint = (
    process.env.AZURE_AI_ENDPOINT ||
    process.env.AZURE_INFERENCE_ENDPOINT ||
    process.env.AZURE_OPENAI_ENDPOINT ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (
    process.env.AZURE_AI_API_KEY ||
    process.env.AZURE_INFERENCE_CREDENTIAL ||
    process.env.AZURE_OPENAI_API_KEY ||
    ""
  ).trim();
  const provider = (process.env.AZURE_AI_PROVIDER || "").toLowerCase();
  const deployment = (
    process.env.AZURE_AI_DEPLOYMENT ||
    process.env.AZURE_AI_MODEL ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    ""
  ).trim();

  if (!endpoint || !apiKey) {
    return null;
  }

  if (/\/openai\/responses(?:\?|$)/.test(endpoint)) {
    return {
      api: "responses",
      url: appendApiVersion(endpoint, openAiApiVersion()),
      auth: "api-key",
      includeModel: true,
      model: deployment
    };
  }

  if (/\/chat\/completions(?:\?|$)/.test(endpoint)) {
    return {
      api: "chat-completions",
      url: appendApiVersion(endpoint, provider.includes("openai") ? openAiApiVersion() : foundryApiVersion()),
      auth: endpoint.includes("/openai/v1") ? "bearer" : "api-key",
      includeModel: !endpoint.includes("/openai/deployments/"),
      model: deployment
    };
  }

  if (endpoint.includes("/openai/v1")) {
    return {
      api: "chat-completions",
      url: `${endpoint}/chat/completions`,
      auth: "bearer",
      includeModel: true,
      model: deployment
    };
  }

  if (provider === "azure-openai" || endpoint.includes(".openai.azure.com")) {
    if (!deployment) {
      throw new Error("Set AZURE_OPENAI_DEPLOYMENT or AZURE_AI_DEPLOYMENT for Azure OpenAI.");
    }

    if (endpoint.includes(".cognitiveservices.azure.com")) {
      return {
        api: "responses",
        url: `${endpoint}/openai/responses?api-version=${openAiApiVersion()}`,
        auth: "api-key",
        includeModel: true,
        model: deployment
      };
    }

    return {
      api: "chat-completions",
      url: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${openAiApiVersion()}`,
      auth: "api-key",
      includeModel: false
    };
  }

  return {
    api: "chat-completions",
    url: `${endpoint.endsWith("/models") ? endpoint : `${endpoint}/models`}/chat/completions?api-version=${foundryApiVersion()}`,
    auth: "api-key",
    includeModel: Boolean(deployment),
    model: deployment
  };
}

async function gradeWithAzure(payload: GradeRequest, target: AzureTarget): Promise<GradeResult> {
  const apiKey =
    process.env.AZURE_AI_API_KEY ||
    process.env.AZURE_INFERENCE_CREDENTIAL ||
    process.env.AZURE_OPENAI_API_KEY ||
    "";

  const systemPrompt =
    "You are a strict but practical YC interview coach. Grade founder answers for a fast YC interview. Reward clear, concise, concrete, user-focused answers with evidence. Penalize vagueness, rambling, buzzwords, projections without proof, and answers that dodge the question. Do not invent facts, traction, users, revenue, or product details that were not provided. Never use vague meta-phrases like 'unavailable to evaluate', 'insufficient information', or 'the response was unavailable'; instead say exactly what concrete detail is missing. Return only valid JSON.";

  const body =
    target.api === "responses"
      ? buildResponsesBody(target, systemPrompt, payload)
      : buildChatCompletionsBody(target, systemPrompt, payload);

  if (target.includeModel && !target.model) {
    throw new Error("Set AZURE_OPENAI_DEPLOYMENT, AZURE_AI_DEPLOYMENT, or AZURE_AI_MODEL.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (target.auth === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers["api-key"] = apiKey;
  }

  const response = await fetch(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Azure returned ${response.status}: ${text.slice(0, 240)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Azure returned a non-JSON response.");
  }

  const content = extractAssistantContent(parsed);
  const rawGrade = parseJsonObject(content);
  return normalizeGrade(rawGrade, "azure");
}

function buildChatCompletionsBody(target: AzureTarget, systemPrompt: string, payload: GradeRequest) {
  const body: Record<string, unknown> = {
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: buildPrompt(payload)
      }
    ],
    max_tokens: 750,
    response_format: { type: "json_object" }
  };

  if (target.includeModel && target.model) {
    body.model = target.model;
  }

  return body;
}

function buildResponsesBody(target: AzureTarget, systemPrompt: string, payload: GradeRequest) {
  const body: Record<string, unknown> = {
    input: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: buildPrompt(payload)
      }
    ],
    max_output_tokens: 900
  };

  if (target.model) {
    body.model = target.model;
  }

  return body;
}

function buildPrompt(payload: GradeRequest) {
  const seconds = Math.round(payload.elapsedMs / 1000);
  const context = payload.startupContext?.trim()
    ? `\nStartup context:\n${payload.startupContext.trim()}\n`
    : "";

  return `Question type: ${payload.questionType}
Question: ${payload.question}
Answer time: ${seconds}s
${context}
Founder answer:
${payload.answer.trim()}

Return this exact JSON shape:
{
  "overall": 1-10,
  "metrics": {
    "clarity": 1-10,
    "specificity": 1-10,
    "userInsight": 1-10,
    "defensibility": 1-10,
    "brevity": 1-10
  },
  "strengths": ["short bullet", "short bullet"],
  "improvements": ["short bullet", "short bullet"],
  "sharperAnswer": "A tighter answer in the founder's voice, 35-80 words.",
  "followUpQuestion": "The likely YC follow-up question.",
  "summary": "One sentence verdict."
}

Rubric:
- Clarity: Does the first sentence directly answer the question?
- Specificity: Does the answer include concrete numbers, named users/customers, dates, channels, or examples?
- User insight: Does it show real understanding of user pain, behavior, reluctance, or buying intent?
- Defensibility: Does it explain why this team or approach has an edge?
- Brevity: Would this work in a 30-60 second YC interview answer?

Rules:
- Grade only the founder answer above. Do not assume missing facts.
- If the answer is very short, score it low and name the exact missing pieces.
- Avoid generic coaching. Every improvement must refer to this question.
- The sharperAnswer must not invent traction or facts. Use placeholders only if needed, like "[specific user]" or "[number]".
- Do not use the words "unavailable" or "insufficient".`;
}

function extractAssistantContent(response: unknown) {
  if (!isRecord(response)) {
    throw new Error("Azure response had an unexpected shape.");
  }

  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const message = choices[0].message;
    if (isRecord(message) && typeof message.content === "string") {
      return message.content;
    }
  }

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  if (Array.isArray(response.output)) {
    const chunks: string[] = [];

    response.output.forEach((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) {
        return;
      }

      item.content.forEach((contentItem) => {
        if (!isRecord(contentItem)) {
          return;
        }

        if (typeof contentItem.text === "string") {
          chunks.push(contentItem.text);
        }
      });
    });

    if (chunks.length) {
      return chunks.join("\n");
    }
  }

  throw new Error("Azure response did not include assistant content.");
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("The grader did not return JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function normalizeGrade(input: unknown, source: "azure" | "heuristic"): GradeResult {
  const record = isRecord(input) ? input : {};
  const rawMetrics = isRecord(record.metrics) ? record.metrics : {};

  const metrics = metricKeys.reduce((accumulator, key) => {
    accumulator[key] = clampScore(rawMetrics[key]);
    return accumulator;
  }, {} as GradeMetrics);

  return {
    overall: clampScore(record.overall),
    metrics,
    strengths: normalizeList(record.strengths),
    improvements: normalizeList(record.improvements),
    sharperAnswer: normalizeString(record.sharperAnswer, "Answer the question directly with concrete evidence and one clear next step."),
    followUpQuestion: normalizeString(record.followUpQuestion, "What evidence do you have that this is working?"),
    summary: normalizeString(record.summary, "A usable answer, but make it more concrete and direct."),
    source
  };
}

function heuristicGrade(payload: GradeRequest): GradeResult {
  const answer = payload.answer.trim();
  const words = answer.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lower = answer.toLowerCase();
  const hasNumber = /\d|percent|revenue|users|customers|weeks|months|days|\$/.test(lower);
  const hasUserSignal = /user|customer|buyer|founder|team|pilot|interview|talked|paid|waitlist|churn|retention/.test(lower);
  const hasEvidence = /built|launched|learned|tested|measured|because|data|usage|growth|demo|shipping|paying/.test(lower);
  const hasContrast = /different|unlike|instead|competitor|alternative|existing|why/.test(lower);

  const clarity = scoreFrom([
    wordCount >= 12,
    wordCount <= 95,
    /because|so|we|i/.test(lower),
    !/sort of|kind of|basically|maybe|probably/.test(lower)
  ]);
  const specificity = scoreFrom([hasNumber, hasEvidence, /first|next|today|currently|now/.test(lower), hasContrast]);
  const userInsight = scoreFrom([hasUserSignal, /problem|pain|need|workflow|behavior|reluctant/.test(lower), /learned|surprised|heard|observed/.test(lower)]);
  const defensibility = scoreFrom([hasEvidence, /expertise|domain|unique|hard|advantage|distribution|speed|relationship/.test(lower), hasNumber]);
  const brevity = wordCount < 8 ? 3 : wordCount <= 80 ? 8 : wordCount <= 120 ? 6 : 4;

  const metrics = { clarity, specificity, userInsight, defensibility, brevity };
  const overall = Math.round(
    (clarity * 0.25 + specificity * 0.22 + userInsight * 0.2 + defensibility * 0.2 + brevity * 0.13) * 10
  ) / 10;

  const improvements = [
    !hasNumber ? "Add one concrete number, customer count, timeline, or usage signal." : "",
    !hasUserSignal ? "Tie the answer to a specific user or customer behavior." : "",
    wordCount > 95 ? "Cut the answer to the strongest 30 to 60 seconds." : "",
    !hasEvidence ? "Ground the claim in something you built, shipped, tested, or learned." : ""
  ].filter(Boolean);

  return {
    overall,
    metrics,
    strengths: [
      wordCount <= 95 ? "The answer is within an interview-friendly length." : "You gave enough raw material to tighten into a strong answer.",
      hasEvidence ? "There is at least some evidence behind the claim." : "The core answer is captured and ready to sharpen."
    ],
    improvements: improvements.length ? improvements : ["Make the first sentence even more direct.", "End with the next specific action."],
    sharperAnswer: buildHeuristicRewrite(payload, wordCount),
    followUpQuestion: "What is the strongest evidence that users care about this?",
    summary: overall >= 7 ? "Solid answer; make it a little sharper and more quantified." : "Promising start; it needs more evidence, specificity, and user language.",
    source: "heuristic"
  };
}

function buildHeuristicRewrite(payload: GradeRequest, wordCount: number) {
  if (wordCount < 12) {
    return "Direct answer: we are focused on one specific user, one painful problem, and one measurable proof point. The next version should name the user, the pain, the evidence, and what we are doing next.";
  }

  return "The stronger version should start with the direct answer, add one concrete proof point from users or usage, explain why that proof matters, and end with the next action. Keep it under a minute.";
}

function scoreFrom(checks: boolean[]) {
  const passed = checks.filter(Boolean).length;
  return clampScore(3 + (passed / checks.length) * 7);
}

function clampScore(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.round(number * 10) / 10));
}

function normalizeList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => cleanFeedbackText(String(item))).filter(Boolean).slice(0, 4);
}

function normalizeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? cleanFeedbackText(value) : fallback;
}

function cleanFeedbackText(value: string) {
  return value
    .replace(/\btoo unavailable to evaluate\b/gi, "too thin to evaluate well")
    .replace(/\bunavailable to evaluate\b/gi, "too thin to evaluate well")
    .replace(/\bunavailable\b/gi, "missing")
    .replace(/\binsufficient information\b/gi, "not enough concrete detail")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function foundryApiVersion() {
  return process.env.AZURE_AI_API_VERSION || "2024-05-01-preview";
}

function openAiApiVersion() {
  return process.env.AZURE_OPENAI_API_VERSION || process.env.AZURE_AI_API_VERSION || "2024-10-21";
}

function appendApiVersion(url: string, version: string) {
  if (url.includes("api-version=") || url.includes("/openai/v1")) {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}api-version=${version}`;
}
