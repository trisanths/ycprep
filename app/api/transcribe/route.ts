import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const deployment = (
    process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT ||
    process.env.AZURE_OPENAI_AUDIO_DEPLOYMENT ||
    ""
  ).trim();
  const endpoint = (
    process.env.AZURE_OPENAI_TRANSCRIPTION_ENDPOINT ||
    process.env.AZURE_OPENAI_ENDPOINT ||
    ""
  ).trim();
  const apiKey = (process.env.AZURE_OPENAI_API_KEY || "").trim();

  if (!deployment || !endpoint || !apiKey) {
    return NextResponse.json(
      {
        error:
          "No Azure transcription deployment is configured. Set AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT to use recorded-audio fallback."
      },
      { status: 400 }
    );
  }

  const incoming = await request.formData();
  const audio = incoming.get("audio");

  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing audio file." }, { status: 400 });
  }

  const formData = new FormData();
  formData.append("file", audio, audio.name || "response.webm");
  formData.append("language", "en");
  formData.append("response_format", "json");

  const response = await fetch(
    `${azureOpenAiRoot(endpoint)}/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions?api-version=${transcriptionApiVersion()}`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey
      },
      body: formData
    }
  );

  const text = await response.text();

  if (!response.ok) {
    return NextResponse.json(
      { error: `Azure transcription failed: ${response.status} ${text.slice(0, 240)}` },
      { status: 502 }
    );
  }

  try {
    const data = JSON.parse(text) as { text?: unknown };
    const transcript = typeof data.text === "string" ? data.text.trim() : "";
    if (!transcript) {
      return NextResponse.json({ error: "Azure returned an empty transcript." }, { status: 502 });
    }

    return NextResponse.json({ transcript });
  } catch {
    return NextResponse.json({ error: "Azure returned a non-JSON transcription response." }, { status: 502 });
  }
}

function azureOpenAiRoot(endpoint: string) {
  return endpoint
    .replace(/\/+$/, "")
    .replace(/\/openai\/responses(?:\?.*)?$/i, "")
    .replace(/\/openai\/deployments\/[^/]+\/.*$/i, "")
    .replace(/\/openai\/v1\/?$/i, "");
}

function transcriptionApiVersion() {
  return process.env.AZURE_OPENAI_TRANSCRIPTION_API_VERSION || "2024-06-01";
}
