/** Owns one Gradium speech-to-speech connection, including pending upgrades. */
export class TranslationSession {
  readonly #abort = new AbortController();
  #socket: WebSocket | null = null;
  #closed = false;
  #ready = false;

  constructor(
    private readonly apiKey: string,
    private readonly send: (message: Record<string, unknown>) => void
  ) {}

  async connect(targetLanguage: string, voiceId: string): Promise<boolean> {
    try {
      const response = await fetch("https://api.gradium.ai/api/speech/s2s", {
        headers: { Upgrade: "websocket", "x-api-key": this.apiKey },
        signal: this.#abort.signal
      });
      const socket = response.webSocket;
      if (!socket) throw new Error("Gradium translation connection failed.");
      if (this.#closed) {
        try {
          socket.accept();
        } finally {
          this.#dispose(socket);
        }
        return false;
      }
      this.#socket = socket;
      socket.addEventListener("message", this.#onMessage);
      socket.addEventListener("error", this.#onError);
      socket.addEventListener("close", this.#onError);
      socket.accept();
      if (this.#closed) return false;
      socket.send(
        JSON.stringify({
          type: "setup",
          model_name: "s2s-translate",
          stt_model_name: "stt-translate",
          tts_model_name: "default",
          input_format: "pcm",
          output_format: "pcm",
          voice_id: voiceId,
          json_config: { target_language: targetLanguage }
        })
      );
      return true;
    } catch {
      if (!this.#closed) this.#fail();
      return false;
    }
  }

  feed(audio: string): void {
    if (this.#closed || !this.#ready || !this.#socket) return;
    try {
      this.#socket.send(JSON.stringify({ type: "audio", audio }));
    } catch {
      this.#fail();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) this.#dispose(socket, this.#ready);
    this.#ready = false;
  }

  #dispose(socket: WebSocket, graceful = false): void {
    socket.removeEventListener("message", this.#onMessage);
    socket.removeEventListener("error", this.#onError);
    socket.removeEventListener("close", this.#onError);
    if (graceful) {
      try {
        socket.send(JSON.stringify({ type: "end_of_stream" }));
      } catch {
        // A failed send must not prevent socket cleanup.
      }
    }
    try {
      socket.close();
    } catch {
      // A socket that failed acceptance may already be unusable.
    }
  }

  #fail(): void {
    if (this.#closed) return;
    this.close();
    this.send({ type: "translation-error" });
  }

  #onError = (): void => this.#fail();

  #onMessage = (event: MessageEvent): void => {
    if (this.#closed || typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "ready":
        if (this.#ready) return;
        this.#ready = true;
        this.send({
          type: "translation-ready",
          sampleRate: message.sample_rate
        });
        break;
      case "text":
        if (typeof message.text === "string")
          this.send({ type: "translation-text", text: message.text });
        break;
      case "audio":
        if (typeof message.audio === "string")
          this.send({ type: "translation-audio", audio: message.audio });
        break;
      case "end_of_stream":
        this.close();
        this.send({ type: "translation-stopped" });
        break;
      case "error":
        this.#fail();
        break;
    }
  };
}
