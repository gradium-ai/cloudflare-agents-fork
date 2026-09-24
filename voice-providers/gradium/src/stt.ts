import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "agents/voice";
import {
  logVoiceError,
  toVoiceError,
  VoiceProviderError
} from "agents/voice/errors";
import { arrayBufferToBase64 } from "./audio";
import { parseMessage } from "./messages";

const DEFAULT_MODEL_NAME = "default";
const DEFAULT_STT_INPUT_FORMAT = "pcm_16000";
const DEFAULT_STT_BASE_URL = "wss://api.gradium.ai/api/speech/asr";
const DEFAULT_STT_LANGUAGE = "any";
const DEFAULT_VAD_HORIZON_SECONDS = 2;
const DEFAULT_VAD_THRESHOLD = 0.5;
const DEFAULT_MIN_SPEECH_WORDS = 2;
// About 30 seconds of 16 kHz mono PCM16 audio while the socket connects.
const MAX_PENDING_BYTES = 960_000;

export interface GradiumSTTOptions {
  /** Gradium API key. */
  apiKey: string;
  /** Gradium STT model. @default "default" */
  modelName?: string;
  /** Audio format sent by the voice pipeline. @default "pcm_16000" */
  inputFormat?: string;
  /**
   * Recognition language: "en", "fr", "de", "es", "pt", or "any" to detect it.
   * @default "any"
   */
  language?: string;
  /** Decoder temperature included in Gradium's json_config. */
  temperature?: number;
  /** ASR streaming delay in 80 ms frames. */
  delayInFrames?: number;
  /** Decoder padding bonus included in Gradium's json_config. */
  paddingBonus?: number;
  /** Additional model configuration passed to Gradium. */
  jsonConfig?: Record<string, unknown>;
  /** Semantic VAD horizon used to end a turn, in seconds. @default 2 */
  vadHorizonSeconds?: number;
  /** Semantic VAD inactivity probability used to end a turn. @default 0.5 */
  vadThreshold?: number;
  /**
   * Words required before reporting speech start, which the pipeline uses for
   * barge-in. The microphone stays open while the agent speaks, so a single
   * echoed word can otherwise cut the agent off mid-sentence. @default 2
   */
  minSpeechWords?: number;
  /** Override the Gradium STT WebSocket URL. */
  baseUrl?: string;
}

/**
 * Continuous Gradium speech-to-text for the Agents voice pipeline.
 *
 * Gradium semantic VAD selects a turn boundary. The provider flushes pending
 * recognition at that boundary and emits one stable utterance without closing
 * the per-call transcription socket.
 */
export class GradiumSTT implements Transcriber {
  #options: GradiumSTTOptions;

  constructor(options: GradiumSTTOptions) {
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new GradiumSTTSession(this.#options, options);
  }
}

class GradiumSTTSession implements TranscriberSession {
  #providerOptions: GradiumSTTOptions;
  #sessionOptions: TranscriberSessionOptions | undefined;
  #ws: WebSocket | null = null;
  #closed = false;
  readonly #connectionAbort = new AbortController();
  #socketReady = false;
  #ready: Promise<void>;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #readySettled = false;
  #pendingChunks: ArrayBuffer[] = [];
  #pendingBytes = 0;
  #pendingOverflowLogged = false;
  #transcript = "";
  #speechReported = false;
  #flushSequence = 0;
  #pendingFlushId: number | null = null;

  constructor(
    providerOptions: GradiumSTTOptions,
    sessionOptions?: TranscriberSessionOptions
  ) {
    this.#providerOptions = providerOptions;
    this.#sessionOptions = sessionOptions;
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#ready.catch(() => {});
    void this.#connect();
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    if (!this.#ws || !this.#socketReady) {
      if (this.#pendingBytes + chunk.byteLength > MAX_PENDING_BYTES) {
        if (!this.#pendingOverflowLogged) {
          this.#pendingOverflowLogged = true;
          logVoiceError({
            component: "GradiumSTT",
            stage: "audio_buffer",
            message: "Gradium pending audio buffer full",
            error: new Error("Dropping audio until the socket is ready")
          });
        }
        return;
      }
      this.#pendingBytes += chunk.byteLength;
      this.#pendingChunks.push(chunk);
      return;
    }
    this.#sendAudioChunk(chunk);
  }

  close(): void {
    if (this.#closed) return;
    this.#rejectReady(
      new Error("GradiumSTT: WebSocket closed before session start.")
    );
    this.#cleanup(true);
  }

  #cleanup(graceful = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connectionAbort.abort();
    const socket = this.#ws;
    const endStream = graceful && this.#socketReady;
    this.#ws = null;
    this.#socketReady = false;
    this.#pendingChunks = [];
    this.#pendingBytes = 0;
    this.#transcript = "";
    this.#speechReported = false;
    this.#pendingFlushId = null;
    if (socket) this.#disposeSocket(socket, endStream);
  }

  #disposeSocket(socket: WebSocket, endStream = false): void {
    socket.removeEventListener("message", this.#onMessage);
    socket.removeEventListener("error", this.#onError);
    socket.removeEventListener("close", this.#onClose);
    if (endStream) {
      try {
        socket.send(JSON.stringify({ type: "end_of_stream" }));
      } catch {
        // A closing socket may already reject sends; still release it below.
      }
    }
    try {
      socket.close();
    } catch {
      // Teardown must not mask the failure or make intentional close throw.
    }
  }

  #onError = (event: Event): void => {
    this.#fail(new Error("GradiumSTT: WebSocket error.", { cause: event }));
  };

  #onClose = (event: CloseEvent): void => {
    this.#fail(
      new VoiceProviderError("GradiumSTT: WebSocket closed unexpectedly.", {
        closeCode: event.code,
        closeReason: event.reason,
        wasClean: event.wasClean
      })
    );
  };

  async #connect(): Promise<void> {
    try {
      const url = (this.#providerOptions.baseUrl ?? DEFAULT_STT_BASE_URL)
        .replace(/^wss:\/\//, "https://")
        .replace(/^ws:\/\//, "http://");
      const response = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          "x-api-key": this.#providerOptions.apiKey
        },
        signal: this.#connectionAbort.signal
      });
      const socket = (response as unknown as { webSocket?: WebSocket })
        .webSocket;
      if (!socket) {
        throw new VoiceProviderError("GradiumSTT WebSocket upgrade failed", {
          status: response.status
        });
      }
      // A cancelled upgrade can still resolve with a socket; release it.
      if (this.#closed) {
        try {
          (socket as unknown as { accept: () => void }).accept();
        } finally {
          this.#disposeSocket(socket);
        }
        return;
      }

      this.#ws = socket;
      socket.addEventListener("message", this.#onMessage);
      socket.addEventListener("error", this.#onError);
      socket.addEventListener("close", this.#onClose);
      (socket as unknown as { accept: () => void }).accept();
      if (this.#closed) return;

      this.#sendJSON({
        type: "setup",
        model_name: this.#providerOptions.modelName ?? DEFAULT_MODEL_NAME,
        input_format:
          this.#providerOptions.inputFormat ?? DEFAULT_STT_INPUT_FORMAT,
        json_config: this.#jsonConfig()
      });
    } catch (error) {
      if (this.#closed) return;
      const voiceError = toVoiceError(error, "Gradium STT connection failed");
      logVoiceError({
        component: "GradiumSTT",
        stage: "connection",
        message: "Gradium STT connection failed",
        error: voiceError
      });
      this.#fail(voiceError);
    }
  }

  #jsonConfig(): Record<string, unknown> {
    const config = { ...this.#providerOptions.jsonConfig };
    // Gradium requires a language to start an ASR session.
    config.language =
      this.#sessionOptions?.language ??
      this.#providerOptions.language ??
      config.language ??
      DEFAULT_STT_LANGUAGE;
    if (this.#providerOptions.temperature !== undefined) {
      config.temp = this.#providerOptions.temperature;
    }
    if (this.#providerOptions.delayInFrames !== undefined) {
      config.delay_in_frames = this.#providerOptions.delayInFrames;
    }
    if (this.#providerOptions.paddingBonus !== undefined) {
      config.padding_bonus = this.#providerOptions.paddingBonus;
    }
    return config;
  }

  #onMessage = (event: MessageEvent): void => {
    if (this.#closed) return;
    const message = parseMessage(event.data);
    if (!message) return;

    if (message.type === "ready") {
      if (this.#socketReady) return;
      this.#socketReady = true;
      const pending = this.#pendingChunks;
      this.#pendingChunks = [];
      this.#pendingBytes = 0;
      for (const chunk of pending) {
        if (!this.#sendAudioChunk(chunk)) return;
      }
      this.#resolveReady();
      return;
    }

    if (message.type === "text") {
      const text = message.text;
      if (typeof text !== "string" || !text) return;
      this.#transcript = appendTranscript(this.#transcript, text);
      // Barge-in waits for a few words, so room noise or the agent's own audio
      // echoing back doesn't interrupt it.
      if (
        !this.#speechReported &&
        countWords(this.#transcript) >=
          (this.#providerOptions.minSpeechWords ?? DEFAULT_MIN_SPEECH_WORDS)
      ) {
        this.#speechReported = true;
        this.#sessionOptions?.onSpeechStart?.(this.#transcript);
      }
      if (!this.#closed) this.#sessionOptions?.onInterim?.(this.#transcript);
      return;
    }

    if (message.type === "step" || message.type === "vad") {
      this.#handleVad(message);
      return;
    }

    if (message.type === "flushed") {
      const flushId =
        typeof message.flush_id === "number" ? message.flush_id : undefined;
      if (
        this.#pendingFlushId !== null &&
        (flushId === undefined || flushId === this.#pendingFlushId)
      ) {
        this.#commitUtterance();
      }
      return;
    }

    if (message.type === "end_of_stream") {
      this.#commitUtterance();
      return;
    }

    if (message.type === "error") {
      // Provider message text stays out of errors, per agents/voice/errors.
      const error = new VoiceProviderError("Gradium STT server error", {
        code: "error"
      });
      logVoiceError({
        component: "GradiumSTT",
        stage: "provider_message",
        message: "Gradium STT server error",
        error
      });
      this.#fail(error);
    }
  };

  #handleVad(message: Record<string, unknown>): void {
    if (!this.#transcript || this.#pendingFlushId !== null) return;

    const predictions = message.vad;
    if (!Array.isArray(predictions)) return;
    const prediction = closestVadPrediction(
      predictions,
      this.#providerOptions.vadHorizonSeconds ?? DEFAULT_VAD_HORIZON_SECONDS
    );
    if (
      !prediction ||
      prediction.inactivityProbability <
        (this.#providerOptions.vadThreshold ?? DEFAULT_VAD_THRESHOLD)
    ) {
      return;
    }

    const flushId = ++this.#flushSequence;
    if (this.#sendJSON({ type: "flush", flush_id: flushId })) {
      this.#pendingFlushId = flushId;
    }
  }

  #commitUtterance(): void {
    const transcript = this.#transcript.trim();
    this.#transcript = "";
    this.#speechReported = false;
    this.#pendingFlushId = null;
    if (transcript) this.#sessionOptions?.onUtterance?.(transcript);
  }

  #sendAudioChunk(chunk: ArrayBuffer): boolean {
    return this.#sendJSON({ type: "audio", audio: arrayBufferToBase64(chunk) });
  }

  #sendJSON(message: Record<string, unknown>): boolean {
    if (this.#closed || !this.#ws) return false;
    try {
      this.#ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      const voiceError = toVoiceError(error, "Gradium WebSocket send failed");
      logVoiceError({
        component: "GradiumSTT",
        stage: "websocket_send",
        message: "Gradium WebSocket send failed",
        error: voiceError
      });
      this.#fail(voiceError);
      return false;
    }
  }

  /** Release resources before notifying the caller of a terminal failure. */
  #fail(error: Error): void {
    if (this.#closed) return;
    this.#rejectReady(error);
    this.#cleanup();
    this.#sessionOptions?.onFatalError?.(error);
  }

  #resolveReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyResolve();
  }

  #rejectReady(error: Error): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyReject(error);
  }
}

function closestVadPrediction(
  predictions: unknown[],
  horizonSeconds: number
): { inactivityProbability: number } | null {
  let closest: { distance: number; inactivityProbability: number } | null =
    null;
  for (const value of predictions) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("horizon_s" in value) ||
      !("inactivity_prob" in value)
    )
      continue;
    const horizon = value.horizon_s;
    const probability = value.inactivity_prob;
    if (typeof horizon !== "number" || typeof probability !== "number")
      continue;
    const distance = Math.abs(horizon - horizonSeconds);
    if (!closest || distance < closest.distance) {
      closest = { distance, inactivityProbability: probability };
    }
  }
  return closest;
}

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

function appendTranscript(current: string, next: string): string {
  if (!current) return next.trimStart();
  if (/\s$/.test(current) || /^\s|^[.,!?;:]/.test(next)) {
    return current + next;
  }
  return `${current} ${next}`;
}
