import type { StreamingTTSProvider, TTSProvider } from "agents/voice";
import {
  logVoiceError,
  toVoiceError,
  VoiceProviderError
} from "agents/voice/errors";
import { base64ToArrayBuffer, concatenateBuffers } from "./audio";
import { parseMessage } from "./messages";

// About 30 seconds of 48 kHz mono PCM16 audio waiting for the consumer.
const DEFAULT_MAX_BUFFERED_AUDIO_BYTES = 2_880_000;

const DEFAULT_MODEL_NAME = "default";
const DEFAULT_VOICE_ID = "4SZHfMpw-p46Ywgs";
// Gradium's native rate. Resampling every 80 ms frame to 16 kHz costs latency
// and can leave audible seams, so prefer the native rate by default.
const DEFAULT_TTS_OUTPUT_FORMAT = "pcm";
const DEFAULT_TTS_BASE_URL = "wss://api.gradium.ai/api/speech/tts";

export interface GradiumTTSOptions {
  /** Gradium API key. */
  apiKey: string;
  /** Voice ID from the Gradium voice library. @default Harper */
  voiceId?: string;
  /** Gradium TTS model. @default "default" */
  modelName?: string;
  /**
   * Audio output format. `"pcm"` is Gradium's native 48 kHz mono PCM16;
   * `"pcm_16000"` resamples to 16 kHz. Whichever you pick, `sampleRate` on
   * `withVoice()` must match its rate or playback is pitch-shifted.
   * @default "pcm"
   */
  outputFormat?: string;
  /** Additional model configuration passed to Gradium. */
  jsonConfig?: Record<string, unknown>;
  /** Maximum queued audio bytes before the stream fails. @default 2880000 */
  maxBufferedAudioBytes?: number;
  /** Override the Gradium TTS WebSocket URL. */
  baseUrl?: string;
}

/**
 * Streaming Gradium text-to-speech for the Agents voice pipeline.
 *
 * The default output is Gradium's native 48 kHz mono PCM16, so configure
 * `withVoice()` with `{ audioFormat: "pcm16", sampleRate: 48_000 }`. If you
 * override `outputFormat` to `"pcm_16000"`, change `sampleRate` to match — a
 * mismatch plays back pitch-shifted with no error.
 */
export class GradiumTTS implements TTSProvider, StreamingTTSProvider {
  #options: Required<GradiumTTSOptions>;

  constructor(options: GradiumTTSOptions) {
    const maxBufferedAudioBytes =
      options.maxBufferedAudioBytes ?? DEFAULT_MAX_BUFFERED_AUDIO_BYTES;
    if (
      !Number.isSafeInteger(maxBufferedAudioBytes) ||
      maxBufferedAudioBytes <= 0
    ) {
      throw new RangeError(
        "maxBufferedAudioBytes must be a positive safe integer"
      );
    }
    this.#options = {
      apiKey: options.apiKey,
      modelName: options.modelName ?? DEFAULT_MODEL_NAME,
      voiceId: options.voiceId ?? DEFAULT_VOICE_ID,
      outputFormat: options.outputFormat ?? DEFAULT_TTS_OUTPUT_FORMAT,
      jsonConfig: { ...options.jsonConfig },
      baseUrl: options.baseUrl ?? DEFAULT_TTS_BASE_URL,
      maxBufferedAudioBytes
    };
  }

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    try {
      const chunks: ArrayBuffer[] = [];
      for await (const chunk of this.synthesizeStream(text, signal)) {
        chunks.push(chunk);
      }
      return signal?.aborted ? null : concatenateBuffers(chunks);
    } catch (error) {
      if (!signal?.aborted) {
        logVoiceError({
          component: "GradiumTTS",
          stage: "synthesize",
          message: "Gradium TTS request failed",
          error: toVoiceError(error, "Gradium TTS request failed")
        });
      }
      return null;
    }
  }

  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    if (!text.trim() || signal?.aborted) return;

    const options = this.#options;
    let socket: WebSocket;
    try {
      const url = options.baseUrl
        .replace(/^wss:\/\//, "https://")
        .replace(/^ws:\/\//, "http://");
      const response = await fetch(url, {
        headers: { Upgrade: "websocket", "x-api-key": options.apiKey },
        signal
      });
      const upgraded = (response as unknown as { webSocket?: WebSocket })
        .webSocket;
      if (!upgraded) {
        throw new VoiceProviderError("GradiumTTS WebSocket upgrade failed", {
          status: response.status
        });
      }
      socket = upgraded;
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }

    const source = new TTSAudioSource(socket, text, options, signal);
    const audio = new ReadableStream(source, {
      highWaterMark: options.maxBufferedAudioBytes,
      size: (chunk) => chunk.byteLength
    });
    const reader = audio.getReader();
    try {
      while (!signal?.aborted) {
        const next = await reader.read();
        if (next.done || signal?.aborted) return;
        yield next.value;
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Owns an upgraded socket and bridges Gradium events to a readable stream. */
class TTSAudioSource implements UnderlyingDefaultSource<ArrayBuffer> {
  readonly #socket: WebSocket;
  readonly #text: string;
  readonly #options: Required<GradiumTTSOptions>;
  readonly #signal: AbortSignal | undefined;
  #controller!: ReadableStreamDefaultController<ArrayBuffer>;
  #closed = false;
  #inputSent = false;

  constructor(
    socket: WebSocket,
    text: string,
    options: Required<GradiumTTSOptions>,
    signal?: AbortSignal
  ) {
    this.#socket = socket;
    this.#text = text;
    this.#options = options;
    this.#signal = signal;
  }

  start(controller: ReadableStreamDefaultController<ArrayBuffer>): void {
    this.#controller = controller;
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("error", this.#onError);
    this.#socket.addEventListener("close", this.#onClose);
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });

    try {
      // Install listeners before acceptance so early events cannot be lost.
      (this.#socket as unknown as { accept: () => void }).accept();
      if (this.#signal?.aborted) {
        this.#onAbort();
        return;
      }
      if (this.#closed) return;
      this.#socket.send(
        JSON.stringify({
          type: "setup",
          model_name: this.#options.modelName,
          voice_id: this.#options.voiceId,
          output_format: this.#options.outputFormat,
          json_config: this.#options.jsonConfig
        })
      );
    } catch (error) {
      this.#fail(
        error instanceof Error ? error : new Error("Gradium TTS setup failed")
      );
    }
  }

  cancel(): void {
    this.#cleanup();
  }

  #cleanup(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#socket.removeEventListener("message", this.#onMessage);
    this.#socket.removeEventListener("error", this.#onError);
    this.#socket.removeEventListener("close", this.#onClose);
    try {
      this.#socket.close();
    } catch {
      // Teardown must not mask the result or prevent cancellation.
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#controller.error(error);
    this.#cleanup();
  }

  #onAbort = (): void => {
    // error() drops queued audio and wakes a pending read immediately.
    // The public iterator translates cancellation into normal completion.
    this.#fail(new DOMException("Gradium TTS aborted", "AbortError"));
  };

  #onError = (event: Event): void => {
    this.#fail(new Error("GradiumTTS: WebSocket error.", { cause: event }));
  };

  #onClose = (event: CloseEvent): void => {
    this.#fail(
      new VoiceProviderError(
        "GradiumTTS: WebSocket closed before end_of_stream.",
        {
          closeCode: event.code,
          closeReason: event.reason,
          wasClean: event.wasClean
        }
      )
    );
  };

  #onMessage = (event: MessageEvent): void => {
    if (this.#closed || this.#signal?.aborted) return;
    const message = parseMessage(event.data);
    if (!message) return;

    try {
      switch (message.type) {
        case "ready":
          this.#sendInput();
          return;
        case "audio": {
          const encoded = message.audio;
          if (typeof encoded === "string" && encoded)
            this.#enqueueAudio(encoded);
          return;
        }
        case "end_of_stream":
          // A normal close lets the consumer drain queued audio.
          this.#controller.close();
          this.#cleanup();
          return;
        case "error":
          // Do not expose arbitrary provider message text.
          this.#fail(
            new VoiceProviderError("Gradium TTS server error", {
              code: "error"
            })
          );
          return;
        // Word timestamps and unknown messages do not produce audio.
      }
    } catch {
      this.#fail(
        new VoiceProviderError("Gradium TTS message handling failed", {
          code: "message_error"
        })
      );
    }
  };

  #sendInput(): void {
    if (this.#inputSent) return;
    this.#inputSent = true;
    this.#socket.send(JSON.stringify({ type: "text", text: this.#text }));
    this.#socket.send(JSON.stringify({ type: "end_of_stream" }));
  }

  #enqueueAudio(encoded: string): void {
    const chunk = base64ToArrayBuffer(encoded);
    // WebSocket producers cannot obey stream backpressure.
    if (chunk.byteLength > (this.#controller.desiredSize ?? 0)) {
      this.#fail(
        new VoiceProviderError("Gradium TTS audio buffer full", {
          code: "audio_buffer_overflow"
        })
      );
      return;
    }
    if (chunk.byteLength > 0) this.#controller.enqueue(chunk);
  }
}
