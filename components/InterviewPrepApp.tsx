"use client";

import {
  BarChart3,
  Clock,
  Download,
  History,
  Mic,
  Play,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Wand2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { questions, tips, type Question, type QuestionType } from "@/data/questions";
import { deleteAudioBlob, getAudioBlob, saveAudioBlob } from "@/lib/audioStore";
import type { GradeMetrics, GradeResult, PracticeAttempt } from "@/lib/types";

const ATTEMPTS_KEY = "ycprep.practice.attempts.v1";
const SETTINGS_KEY = "ycprep.practice.settings.v1";
const RECENT_QUESTION_WINDOW = 10;

const typeLabels: Record<QuestionType, string> = {
  GENERAL: "General",
  PRE_LAUNCH: "Pre-launch",
  POST_LAUNCH: "Post-launch"
};

const questionTypes: QuestionType[] = ["GENERAL", "PRE_LAUNCH", "POST_LAUNCH"];
const filters: Array<"ALL" | QuestionType> = ["ALL", ...questionTypes];

const metricLabels: Record<keyof GradeMetrics, string> = {
  clarity: "Clarity",
  specificity: "Specifics",
  userInsight: "Users",
  defensibility: "Defense",
  brevity: "Brevity"
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionLikeEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionLikeEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
};

type WindowWithSpeech = Window & {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

type QuestionStats = {
  attempts: number;
  average: number;
  best: number;
  last?: PracticeAttempt;
  scores: number;
};

export function InterviewPrepApp() {
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState<Question>(questions[0]);
  const [selectedTypes, setSelectedTypes] = useState<QuestionType[]>(questionTypes);
  const [smartDrill, setSmartDrill] = useState(true);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [autoRecord, setAutoRecord] = useState(false);
  const [answer, setAnswer] = useState("");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [practiceCycle, setPracticeCycle] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [latestAttemptId, setLatestAttemptId] = useState<string | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [startupContext, setStartupContext] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSupported, setRecordingSupported] = useState(true);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [currentAudioBlob, setCurrentAudioBlob] = useState<Blob | null>(null);
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | null>(null);
  const [playbackUrls, setPlaybackUrls] = useState<Record<string, string>>({});
  const [ttsSupported, setTtsSupported] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const speechRef = useRef<BrowserSpeechRecognition | null>(null);
  const questionUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const recentQuestionIdsRef = useRef<string[]>([questions[0].id]);
  const answerRef = useRef("");
  const liveTranscriptRef = useRef("");
  const submitLockRef = useRef(false);

  useEffect(() => {
    const rawAttempts = localStorage.getItem(ATTEMPTS_KEY);
    const rawSettings = localStorage.getItem(SETTINGS_KEY);

    if (rawAttempts) {
      try {
        const savedAttempts = JSON.parse(rawAttempts) as PracticeAttempt[];
        setAttempts(savedAttempts);
        setLatestAttemptId(savedAttempts[0]?.id ?? null);
        setSelectedAttemptId(savedAttempts[0]?.id ?? null);
        const nextQuestion = pickQuestion(questionTypes, savedAttempts, true, undefined, recentQuestionIdsRef.current);
        recentQuestionIdsRef.current = rememberQuestionId(recentQuestionIdsRef.current, nextQuestion.id);
        setCurrentQuestion(nextQuestion);
      } catch {
        localStorage.removeItem(ATTEMPTS_KEY);
      }
    }

    if (rawSettings) {
      try {
        const settings = JSON.parse(rawSettings) as {
          autoRecord?: boolean;
          autoSpeak?: boolean;
          selectedTypes?: QuestionType[];
          startupContext?: string;
        };
        setStartupContext(settings.startupContext ?? "");
        setAutoSpeak(Boolean(settings.autoSpeak));
        setAutoRecord(Boolean(settings.autoRecord));
        setSelectedTypes(normalizeSelectedTypes(settings.selectedTypes));
      } catch {
        localStorage.removeItem(SETTINGS_KEY);
      }
    }

    setTtsSupported("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
  }, [attempts, hydrated]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ autoRecord, autoSpeak, selectedTypes, startupContext }));
  }, [autoRecord, autoSpeak, selectedTypes, startupContext, hydrated]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(tick, 50);

    function tick() {
      setNow(Date.now());
    }

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedTypes.includes(currentQuestion.type)) {
      resetQuestion(pickQuestion(selectedTypes, attempts, smartDrill, currentQuestion.id, recentQuestionIdsRef.current));
    }
  }, [attempts, currentQuestion.type, selectedTypes, smartDrill]);

  const statsByQuestion = useMemo(() => buildQuestionStats(attempts), [attempts]);
  const currentQuestionStats = statsByQuestion.get(currentQuestion.id);
  const latestAttempt = attempts.find((attempt) => attempt.id === latestAttemptId) ?? attempts[0];
  const selectedAttempt =
    attempts.find((attempt) => attempt.id === selectedAttemptId) ?? latestAttempt ?? attempts[0];
  const overallStats = useMemo(() => buildOverallStats(attempts), [attempts]);
  const weakQuestions = useMemo(() => buildWeakQuestions(statsByQuestion), [statsByQuestion]);
  const currentTip = useMemo(() => tipForQuestion(currentQuestion), [currentQuestion]);
  const elapsedMs = now - startedAt;
  const answerText = useMemo(() => combineAnswerText(answer, liveTranscript), [answer, liveTranscript]);
  const typedWordCount = countWords(answerText);

  useEffect(() => {
    if (!selectedAttempt?.audioId || playbackUrls[selectedAttempt.id]) {
      return;
    }

    let cancelled = false;
    getAudioBlob(selectedAttempt.audioId).then((blob) => {
      if (!blob || cancelled) {
        return;
      }
      setPlaybackUrls((existing) => ({
        ...existing,
        [selectedAttempt.id]: URL.createObjectURL(blob)
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [playbackUrls, selectedAttempt]);

  const gradeAttempt = useCallback(async (attempt: PracticeAttempt, context: string) => {
    try {
      const response = await fetch("/api/grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: attempt.questionText,
          questionType: attempt.questionType,
          answer: attempt.answer,
          elapsedMs: attempt.elapsedMs,
          startupContext: context
        })
      });
      const data = (await response.json()) as { grade?: GradeResult; error?: string };

      if (!response.ok || !data.grade) {
        throw new Error(data.error ?? "The grader did not return a score.");
      }

      setAttempts((existing) =>
        existing.map((item) =>
          item.id === attempt.id
            ? {
                ...item,
                gradingStatus: "graded",
                grade: data.grade
              }
            : item
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to grade this answer.";
      setAttempts((existing) =>
        existing.map((item) =>
          item.id === attempt.id
            ? {
                ...item,
                gradingStatus: "failed",
                error: message
              }
            : item
        )
      );
    }
  }, []);

  const resetDraft = useCallback(() => {
    answerRef.current = "";
    liveTranscriptRef.current = "";
    setAnswer("");
    setLiveTranscript("");
    setCurrentAudioBlob(null);
    setCurrentAudioUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return null;
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    window.speechSynthesis.cancel();
    questionUtteranceRef.current = null;
    setIsSpeaking(false);
  }, []);

  const discardRecording = useCallback(() => {
    speechRef.current?.stop();
    speechRef.current = null;

    const recorder = mediaRecorderRef.current;
    if (recorder) {
      const stream = recorder.stream;
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;

      if (recorder.state !== "inactive") {
        recorder.stop();
      }

      stream.getTracks().forEach((track) => track.stop());
    }

    chunksRef.current = [];
    mediaRecorderRef.current = null;
    setIsRecording(false);
  }, []);

  const speakQuestion = useCallback(
    (question = currentQuestion) => {
      if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        setTtsSupported(false);
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(question.text);
      utterance.lang = "en-US";
      utterance.rate = 1.03;
      utterance.pitch = 0.96;
      utterance.volume = 1;
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);

      questionUtteranceRef.current = utterance;
      setIsSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [currentQuestion]
  );

  const resetQuestion = useCallback(
    (question = currentQuestion) => {
      const nextQuestion = question;

      stopSpeaking();
      discardRecording();
      resetDraft();
      setCurrentQuestion(nextQuestion);
      recentQuestionIdsRef.current = rememberQuestionId(recentQuestionIdsRef.current, nextQuestion.id);
      setStartedAt(Date.now());
      setNow(Date.now());
      setPracticeCycle((cycle) => cycle + 1);
      setSubmissionError(null);

      if (autoSpeak) {
        window.setTimeout(() => speakQuestion(nextQuestion), 80);
      }
    },
    [autoSpeak, currentQuestion, discardRecording, resetDraft, speakQuestion, stopSpeaking]
  );

  const chooseNextQuestion = useCallback(
    (history = attempts, excludeId?: string) => {
      resetQuestion(pickQuestion(selectedTypes, history, smartDrill, excludeId, recentQuestionIdsRef.current));
    },
    [attempts, resetQuestion, selectedTypes, smartDrill]
  );

  const toggleQuestionType = useCallback((type: QuestionType) => {
    setSelectedTypes((existing) => {
      const withoutType = existing.filter((item) => item !== type);
      const nextTypes = existing.includes(type) ? withoutType : [...existing, type];
      return nextTypes.length ? sortQuestionTypes(nextTypes) : existing;
    });
  }, []);

  const startSpeechRecognition = useCallback(() => {
    const speechWindow = window as WindowWithSpeech;
    const SpeechConstructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

    if (!SpeechConstructor) {
      return;
    }

    try {
      const recognition = new SpeechConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const transcript = event.results[index][0]?.transcript ?? "";
          if (event.results[index].isFinal) {
            finalText += transcript;
          } else {
            interimText += transcript;
          }
        }

        if (finalText.trim()) {
          setAnswer((existing) => {
            const nextAnswer = combineAnswerText(existing, finalText);
            answerRef.current = nextAnswer;
            return nextAnswer;
          });
          liveTranscriptRef.current = "";
          setLiveTranscript("");
        } else {
          const nextTranscript = interimText.trim();
          liveTranscriptRef.current = nextTranscript;
          setLiveTranscript(nextTranscript);
        }
      };
      recognition.onerror = () => {
        liveTranscriptRef.current = "";
        setLiveTranscript("");
      };
      recognition.start();
      speechRef.current = recognition;
    } catch {
      speechRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    return new Promise<Blob | null>((resolve) => {
      speechRef.current?.stop();
      speechRef.current = null;

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        setIsRecording(false);
        resolve(currentAudioBlob);
        return;
      }

      const stream = recorder.stream;
      recorder.onstop = () => {
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })
          : null;

        chunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setIsRecording(false);

        if (blob) {
          setCurrentAudioBlob(blob);
          setCurrentAudioUrl((previous) => {
            if (previous) {
              URL.revokeObjectURL(previous);
            }
            return URL.createObjectURL(blob);
          });
        }

        resolve(blob);
      };

      recorder.stop();
    });
  }, [currentAudioBlob]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordingSupported(false);
      setSubmissionError("This browser does not support in-page recording.");
      return;
    }

    try {
      stopSpeaking();
      resetDraft();
      setSubmissionError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      startSpeechRecognition();
    } catch {
      setSubmissionError("Microphone access was blocked.");
    }
  }, [resetDraft, startSpeechRecognition, stopSpeaking]);

  useEffect(() => {
    if (!hydrated || !autoRecord || isRecording || isSubmitting || currentAudioBlob) {
      return;
    }

    const questionId = currentQuestion.id;
    const delay = autoSpeak ? estimateQuestionSpeechMs(currentQuestion.text) + 450 : 350;
    const timer = window.setTimeout(() => {
      if (currentQuestion.id !== questionId || mediaRecorderRef.current || submitLockRef.current) {
        return;
      }

      void startRecording();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    autoRecord,
    autoSpeak,
    currentAudioBlob,
    currentQuestion,
    hydrated,
    isRecording,
    isSubmitting,
    practiceCycle,
    startRecording
  ]);

  const submitAnswer = useCallback(async () => {
    if (submitLockRef.current) {
      return;
    }

    submitLockRef.current = true;
    setSubmissionError(null);

    try {
      let audioBlob = currentAudioBlob;
      if (isRecording) {
        audioBlob = await stopRecording();
        await waitForSpeechFlush();
      }

      let cleanedAnswer = combineAnswerText(answerRef.current || answer, liveTranscriptRef.current || liveTranscript);
      if (!cleanedAnswer && audioBlob) {
        setIsSubmitting(true);
        try {
          cleanedAnswer = await transcribeAudio(audioBlob);
          answerRef.current = cleanedAnswer;
          liveTranscriptRef.current = "";
          setAnswer(cleanedAnswer);
          setLiveTranscript("");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to transcribe recorded audio.";
          setSubmissionError(message);
          return;
        }
      }

      if (!cleanedAnswer) {
        setSubmissionError(
          audioBlob
            ? "Audio was captured, but there is no transcript to grade. Type the answer or try recording again."
            : "Answer first, then move on."
        );
        return;
      }

      setIsSubmitting(true);

      const id = createId();
      const attempt: PracticeAttempt = {
        id,
        questionId: currentQuestion.id,
        questionText: currentQuestion.text,
        questionType: currentQuestion.type,
        answer: cleanedAnswer,
        elapsedMs: Date.now() - startedAt,
        createdAt: new Date().toISOString(),
        wordCount: countWords(cleanedAnswer),
        gradingStatus: "pending"
      };

      if (audioBlob) {
        await saveAudioBlob(id, audioBlob);
        attempt.audioId = id;
        attempt.audioMimeType = audioBlob.type || "audio/webm";
      }

      const nextAttempts = [attempt, ...attempts].slice(0, 400);
      setAttempts(nextAttempts);
      setLatestAttemptId(id);
      setSelectedAttemptId(id);
      await gradeAttempt(attempt, startupContext);
      chooseNextQuestion(nextAttempts, currentQuestion.id);
    } finally {
      setIsSubmitting(false);
      submitLockRef.current = false;
    }
  }, [
    answer,
    attempts,
    chooseNextQuestion,
    currentAudioBlob,
    currentQuestion,
    gradeAttempt,
    isRecording,
    liveTranscript,
    startedAt,
    startupContext,
    stopRecording
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT") {
        return;
      }

      event.preventDefault();
      void submitAnswer();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [submitAnswer]);

  const deleteAttempt = useCallback(
    async (attempt: PracticeAttempt) => {
      setAttempts((existing) => existing.filter((item) => item.id !== attempt.id));
      if (attempt.audioId) {
        await deleteAudioBlob(attempt.audioId);
      }
      setSelectedAttemptId((current) => (current === attempt.id ? null : current));
      setLatestAttemptId((current) => (current === attempt.id ? null : current));
    },
    []
  );

  const clearHistory = useCallback(async () => {
    if (!window.confirm("Clear saved practice history on this browser?")) {
      return;
    }

    await Promise.all(attempts.map((attempt) => (attempt.audioId ? deleteAudioBlob(attempt.audioId) : null)));
    setAttempts([]);
    setLatestAttemptId(null);
    setSelectedAttemptId(null);
    localStorage.removeItem(ATTEMPTS_KEY);
  }, [attempts]);

  const exportHistory = useCallback(() => {
    const blob = new Blob([JSON.stringify(attempts, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `yc-interview-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [attempts]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="yc-mark">Y</span>
          <span>Interviewer</span>
        </div>
        <nav className="top-actions" aria-label="Practice actions">
          <button className="ghost-button" type="button" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings size={16} aria-hidden />
            Context
          </button>
          <button className="ghost-button" type="button" onClick={exportHistory} disabled={!attempts.length}>
            <Download size={16} aria-hidden />
            Export
          </button>
        </nav>
      </header>

      <main className="app-shell">
        <aside className="left-rail panel">
          <section className="score-stack" aria-label="Session score">
            <div>
              <span className="eyebrow">Session avg</span>
              <strong>{overallStats.average ? overallStats.average.toFixed(1) : "--"}</strong>
            </div>
            <div>
              <span className="eyebrow">Answered</span>
              <strong>{attempts.length}</strong>
            </div>
            <div>
              <span className="eyebrow">Trend</span>
              <strong className={overallStats.trend >= 0 ? "positive" : "negative"}>
                {overallStats.trend ? `${overallStats.trend > 0 ? "+" : ""}${overallStats.trend.toFixed(1)}` : "--"}
              </strong>
            </div>
          </section>

          <section className="rail-section">
            <div className="section-title">
              <BarChart3 size={17} aria-hidden />
              Queue
            </div>
            <div className="segmented" role="group" aria-label="Question categories">
              {filters.map((item) => (
                <button
                  aria-pressed={item === "ALL" ? selectedTypes.length === questionTypes.length : selectedTypes.includes(item)}
                  className={
                    item === "ALL"
                      ? selectedTypes.length === questionTypes.length
                        ? "active"
                        : ""
                      : selectedTypes.includes(item)
                        ? "active"
                        : ""
                  }
                  key={item}
                  type="button"
                  onClick={() => (item === "ALL" ? setSelectedTypes(questionTypes) : toggleQuestionType(item))}
                >
                  {item === "ALL" ? "All" : typeLabels[item]}
                </button>
              ))}
            </div>
            <label className="switch-row">
              <input checked={smartDrill} onChange={(event) => setSmartDrill(event.target.checked)} type="checkbox" />
              <span>Smart drill</span>
            </label>
            <label className="switch-row">
              <input
                checked={autoSpeak}
                disabled={!ttsSupported}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setAutoSpeak(enabled);

                  if (enabled) {
                    speakQuestion(currentQuestion);
                  } else {
                    stopSpeaking();
                  }
                }}
                type="checkbox"
              />
              <span>Auto-read question</span>
            </label>
            <label className="switch-row">
              <input
                checked={autoRecord}
                disabled={!recordingSupported}
                onChange={(event) => setAutoRecord(event.target.checked)}
                type="checkbox"
              />
              <span>Auto-record answer</span>
            </label>
          </section>

          <section className="rail-section">
            <div className="section-title">
              <Sparkles size={17} aria-hidden />
              Weak Spots
            </div>
            <div className="weak-list">
              {weakQuestions.length ? (
                weakQuestions.map(({ question, stats }) => (
                  <button
                    className="weak-item"
                    key={question.id}
                    type="button"
                    onClick={() => resetQuestion(question)}
                  >
                    <span>{question.text}</span>
                    <strong>{stats.average.toFixed(1)}</strong>
                  </button>
                ))
              ) : (
                <p className="empty-copy">No graded answers yet.</p>
              )}
            </div>
          </section>
        </aside>

        <section className="stage" aria-label="Current interview question">
          <div className="stage-meta">
            <span className="type-chip">{typeLabels[currentQuestion.type]}</span>
            <span className="timer-chip">
              <Clock size={18} aria-hidden />
              {formatTime(elapsedMs)}
            </span>
            <button
              className={`voice-command ${isSpeaking ? "speaking" : ""}`}
              disabled={!ttsSupported || isRecording}
              onClick={isSpeaking ? stopSpeaking : () => speakQuestion()}
              title={isSpeaking ? "Stop question audio" : "Read question aloud"}
              type="button"
            >
              {isSpeaking ? <VolumeX size={18} aria-hidden /> : <Volume2 size={18} aria-hidden />}
              {isSpeaking ? "Stop" : "Listen"}
            </button>
          </div>

          <div className="question-wrap">
            <p className="tip-line">*Tip: {currentTip.text}</p>
            <h1>{currentQuestion.text}</h1>
            <div className="question-stats">
              <span>Attempts: {currentQuestionStats?.attempts ?? 0}</span>
              <span>Avg: {currentQuestionStats ? currentQuestionStats.average.toFixed(1) : "--"}</span>
              <span>Best: {currentQuestionStats ? currentQuestionStats.best.toFixed(1) : "--"}</span>
            </div>
          </div>

          <div className="answer-surface">
            <textarea
              aria-label="Your answer"
              className="answer-box"
              onChange={(event) => {
                const nextAnswer = event.target.value;
                answerRef.current = nextAnswer;
                liveTranscriptRef.current = "";
                setAnswer(nextAnswer);
                setLiveTranscript("");
              }}
              placeholder="Speak or type your answer..."
              value={answerText}
            />
            {isRecording ? (
              <div className="live-transcript">
                <strong>Transcript</strong>
                <span>{liveTranscript || answerText || "Listening..."}</span>
              </div>
            ) : null}
            <div className="draft-meta">
              <span>{typedWordCount} words</span>
              <span>{currentAudioBlob ? "Audio saved for this draft" : recordingSupported ? "Mic ready" : "Mic unavailable"}</span>
            </div>
          </div>

          {currentAudioUrl ? (
            <audio className="draft-audio" controls src={currentAudioUrl}>
              <track kind="captions" />
            </audio>
          ) : null}

          {submissionError ? <p className="form-error">{submissionError}</p> : null}

          <div className="controls">
            <button
              className={`icon-command ${isRecording ? "danger" : ""}`}
              disabled={isSubmitting}
              type="button"
              onClick={isRecording ? () => void stopRecording() : startRecording}
              title={isRecording ? "Stop recording" : "Record answer"}
            >
              {isRecording ? <Square size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
              {isRecording ? "Stop" : "Record"}
            </button>
            <button className="secondary-command" disabled={isSubmitting} type="button" onClick={() => resetQuestion()}>
              <RotateCcw size={17} aria-hidden />
              Reset
            </button>
            <button className="secondary-command" disabled={isSubmitting} type="button" onClick={() => chooseNextQuestion()}>
              <Play size={17} aria-hidden />
              Skip
            </button>
            <button className="primary-command" disabled={isSubmitting} type="button" onClick={() => void submitAnswer()}>
              <Send size={18} aria-hidden />
              {isSubmitting ? "Grading..." : "Next"}
            </button>
          </div>
        </section>

        <aside className="coach-panel panel">
          <section className="coach-section">
            <div className="section-title">
              <Wand2 size={17} aria-hidden />
              Immediate Grade
            </div>
            <GradePanel attempt={latestAttempt} />
          </section>

          <section className="coach-section">
            <div className="section-title">
              <History size={17} aria-hidden />
              History
              {attempts.length ? (
                <button className="text-command" type="button" onClick={() => void clearHistory()}>
                  <Trash2 size={14} aria-hidden />
                  Clear
                </button>
              ) : null}
            </div>
            <div className="history-list">
              {attempts.length ? (
                attempts.slice(0, 18).map((attempt) => (
                  <button
                    className={`history-item ${selectedAttempt?.id === attempt.id ? "selected" : ""}`}
                    key={attempt.id}
                    type="button"
                    onClick={() => setSelectedAttemptId(attempt.id)}
                  >
                    <span>{attempt.questionText}</span>
                    <strong>
                      {attempt.gradingStatus === "pending"
                        ? "..."
                        : attempt.grade
                          ? attempt.grade.overall.toFixed(1)
                          : "!"}
                    </strong>
                  </button>
                ))
              ) : (
                <p className="empty-copy">Your answered questions will land here.</p>
              )}
            </div>
          </section>

          {selectedAttempt ? (
            <section className="coach-section selected-review">
              <div className="review-heading">
                <span>{new Date(selectedAttempt.createdAt).toLocaleString()}</span>
                <button className="text-command" type="button" onClick={() => void deleteAttempt(selectedAttempt)}>
                  <Trash2 size={14} aria-hidden />
                  Delete
                </button>
              </div>
              <h2>{selectedAttempt.questionText}</h2>
              <p>{selectedAttempt.answer}</p>
              {selectedAttempt.audioId && playbackUrls[selectedAttempt.id] ? (
                <audio className="history-audio" controls src={playbackUrls[selectedAttempt.id]}>
                  <track kind="captions" />
                </audio>
              ) : null}
            </section>
          ) : null}
        </aside>
      </main>

      {settingsOpen ? (
        <div className="settings-drawer" role="dialog" aria-label="Startup context">
          <div className="settings-header">
            <strong>Startup Context</strong>
            <button className="ghost-button" type="button" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
          <textarea
            aria-label="Startup context for grading"
            onChange={(event) => setStartupContext(event.target.value)}
            placeholder="Company, customer, stage, traction, revenue, market, and anything the grader should know."
            value={startupContext}
          />
        </div>
      ) : null}
    </>
  );
}

function GradePanel({ attempt }: { attempt?: PracticeAttempt }) {
  if (!attempt) {
    return <p className="empty-copy">Answer a question to get a score.</p>;
  }

  if (attempt.gradingStatus === "pending") {
    return (
      <div className="grading-pending">
        <span className="spinner" aria-hidden />
        <p>Grading your last answer...</p>
      </div>
    );
  }

  if (attempt.gradingStatus === "failed" || !attempt.grade) {
    return <p className="form-error">{attempt.error ?? "This answer could not be graded."}</p>;
  }

  const grade = attempt.grade;

  return (
    <div className="grade-card">
      <div className="grade-score">
        <strong>{grade.overall.toFixed(1)}</strong>
        <span>{grade.source === "azure" ? "Azure AI" : "Local rubric"}</span>
      </div>
      {grade.warning ? <p className="warning-copy">{grade.warning}</p> : null}
      <p className="grade-summary">{grade.summary}</p>
      <div className="metric-list">
        {(Object.keys(metricLabels) as Array<keyof GradeMetrics>).map((key) => (
          <div className="metric-row" key={key}>
            <span>{metricLabels[key]}</span>
            <div className="meter">
              <i style={{ width: `${grade.metrics[key] * 10}%` }} />
            </div>
            <strong>{grade.metrics[key].toFixed(1)}</strong>
          </div>
        ))}
      </div>
      <div className="feedback-columns">
        <div>
          <h3>Keep</h3>
          <ul>
            {grade.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Fix</h3>
          <ul>
            {grade.improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="rewrite-box">
        <h3>Sharper Version</h3>
        <p>{grade.sharperAnswer}</p>
      </div>
      <div className="follow-up">
        <span>Likely follow-up</span>
        <p>{grade.followUpQuestion}</p>
      </div>
    </div>
  );
}

function pickQuestion(
  selectedTypes: QuestionType[],
  history: PracticeAttempt[],
  smartDrill: boolean,
  excludeId?: string,
  sessionRecentQuestionIds: string[] = []
) {
  const activeTypes = normalizeSelectedTypes(selectedTypes);
  const pool = questions.filter((question) => activeTypes.includes(question.type));
  const candidates = pool.filter((question) => question.id !== excludeId);
  const workingPool = candidates.length ? candidates : pool;
  const recentLimit = Math.min(RECENT_QUESTION_WINDOW, Math.max(2, Math.floor(workingPool.length * 0.45)));
  const recentQuestionIds = new Set(
    [
      ...sessionRecentQuestionIds,
      ...history
      .map((attempt) => attempt.questionId)
    ]
      .filter((questionId) => questionId !== excludeId)
      .slice(0, recentLimit)
  );
  const freshPool = workingPool.filter((question) => !recentQuestionIds.has(question.id));
  const rotationPool = freshPool.length >= Math.min(4, workingPool.length) ? freshPool : workingPool;

  if (!smartDrill || history.length < 3) {
    return randomFrom(rotationPool);
  }

  const stats = buildQuestionStats(history);
  const weighted = rotationPool.map((question, index) => {
    const item = stats.get(question.id);
    const attempts = item?.attempts ?? 0;
    const average = item?.scores ? item.average : 6.2;
    const scarcityBoost = attempts === 0 ? 8 : attempts === 1 ? 4 : 0;
    const weaknessBoost = Math.max(0, 8 - average);
    const jitter = Math.random() * 1.5;

    return {
      question,
      weight: Math.max(1, 1 + scarcityBoost + weaknessBoost + jitter + (index % 3) * 0.2)
    };
  });

  return weightedRandom(weighted);
}

function buildQuestionStats(history: PracticeAttempt[]) {
  const grouped = new Map<string, { attempts: PracticeAttempt[]; scores: number[] }>();

  history.forEach((attempt) => {
    const existing = grouped.get(attempt.questionId) ?? { attempts: [], scores: [] };
    existing.attempts.push(attempt);
    if (attempt.grade) {
      existing.scores.push(attempt.grade.overall);
    }
    grouped.set(attempt.questionId, existing);
  });

  const stats = new Map<string, QuestionStats>();
  grouped.forEach((value, questionId) => {
    const scores = value.scores.length ? value.scores : [0];
    const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    stats.set(questionId, {
      attempts: value.attempts.length,
      average,
      best: Math.max(...scores),
      last: value.attempts[0],
      scores: value.scores.length
    });
  });

  return stats;
}

function buildOverallStats(history: PracticeAttempt[]) {
  const graded = history.filter((attempt) => attempt.grade);
  const average = graded.length
    ? graded.reduce((sum, attempt) => sum + (attempt.grade?.overall ?? 0), 0) / graded.length
    : 0;
  const recent = graded.slice(0, 5);
  const previous = graded.slice(5, 10);
  const recentAverage = recent.length
    ? recent.reduce((sum, attempt) => sum + (attempt.grade?.overall ?? 0), 0) / recent.length
    : 0;
  const previousAverage = previous.length
    ? previous.reduce((sum, attempt) => sum + (attempt.grade?.overall ?? 0), 0) / previous.length
    : 0;

  return {
    average,
    trend: recent.length && previous.length ? recentAverage - previousAverage : 0
  };
}

function buildWeakQuestions(stats: Map<string, QuestionStats>) {
  return questions
    .map((question) => ({
      question,
      stats: stats.get(question.id)
    }))
    .filter((item): item is { question: Question; stats: QuestionStats } => Boolean(item.stats?.attempts))
    .sort((a, b) => a.stats.average - b.stats.average)
    .slice(0, 4);
}

function tipForQuestion(question: Question) {
  const matching = tips.filter((tip) => tip.type === question.type || tip.type === "GENERAL");
  return matching[Math.abs(hash(question.id)) % matching.length];
}

function randomFrom<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function weightedRandom<T>(items: Array<{ question: T; weight: number }>) {
  if (!items.length) {
    throw new Error("Cannot pick from an empty question pool.");
  }

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * totalWeight;

  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item.question;
    }
  }

  return items[items.length - 1].question;
}

function rememberQuestionId(existing: string[], questionId: string) {
  return [questionId, ...existing.filter((id) => id !== questionId)].slice(0, RECENT_QUESTION_WINDOW);
}

function hash(value: string) {
  return value.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function normalizeSelectedTypes(types?: QuestionType[]) {
  if (!Array.isArray(types)) {
    return questionTypes;
  }

  const validTypes = types.filter((type): type is QuestionType => questionTypes.includes(type));
  return validTypes.length ? sortQuestionTypes(validTypes) : questionTypes;
}

function sortQuestionTypes(types: QuestionType[]) {
  return questionTypes.filter((type) => types.includes(type));
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function countWords(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function combineAnswerText(...parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function waitForSpeechFlush() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 250);
  });
}

async function transcribeAudio(blob: Blob) {
  const formData = new FormData();
  formData.append("audio", blob, `response.${audioExtension(blob.type)}`);

  const response = await fetch("/api/transcribe", {
    method: "POST",
    body: formData
  });
  const data = (await response.json()) as { error?: string; transcript?: string };

  if (!response.ok || !data.transcript?.trim()) {
    throw new Error(data.error ?? "Unable to transcribe recorded audio.");
  }

  return data.transcript.trim();
}

function audioExtension(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }
  if (mimeType.includes("mpeg")) {
    return "mp3";
  }
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function estimateQuestionSpeechMs(question: string) {
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1400, words * 430);
}

function formatTime(ms: number) {
  return `${(Math.max(0, Math.floor(ms / 100)) / 10).toFixed(1)}s`;
}
