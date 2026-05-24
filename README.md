# YC Interviewer

A local YC interview prep room with typed answers, browser mic recording, saved question history, per-question performance, and immediate grading.

## Run Locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:3000`.

## Azure AI Foundry Grading

From your current Azure deployments, use `gpt-5.5` first. It is the best fit for structured answer grading and coaching. Create `.env.local` from `.env.local.example`, then set the endpoint from **Get endpoint** in Azure and paste your key:

```env
AZURE_AI_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://<your-resource-name>.cognitiveservices.azure.com/openai/responses
AZURE_OPENAI_DEPLOYMENT=gpt-5.5
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_API_VERSION=2025-04-01-preview
```

`model-router` should also work as `AZURE_OPENAI_DEPLOYMENT=model-router` if you prefer routing. For the non-Azure-OpenAI model inference deployments such as `DeepSeek-V4-Flash` or `Kimi-K2.6`, use:

```env
AZURE_AI_ENDPOINT=https://<resource>.services.ai.azure.com/models
AZURE_AI_API_KEY=<key>
AZURE_AI_MODEL=DeepSeek-V4-Flash
AZURE_AI_API_VERSION=2024-05-01-preview
```

The key is only read by the server route at `app/api/grade/route.ts`; it is not sent to the browser. If Azure is not configured or a request fails, the app still grades with a local rubric so practice is never blocked.

For recorded-audio transcription fallback, deploy a Whisper or transcription model in Azure and add:

```env
AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT=<deployment-name>
AZURE_OPENAI_TRANSCRIPTION_API_VERSION=2024-06-01
```

The app first uses browser speech recognition so transcripts appear live in the answer box. If the browser captures audio but does not produce text, it will try this Azure transcription deployment before grading.
