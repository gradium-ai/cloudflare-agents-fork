import { Agent, callable, getCurrentAgent, type Connection } from "agents";
import { TranslationSession } from "../lib/translation-session";

/** Live speech translation over one Gradium speech-to-speech socket. */
export class TranslateAgent extends Agent<Env> {
  #session: TranslationSession | null = null;
  #owner: string | undefined;

  @callable()
  async startTranslation(targetLanguage: string, voiceId: string) {
    this.#closeSession();
    const connection = getCurrentAgent().connection;
    if (!connection)
      throw new Error("Translation requires a browser connection.");
    this.#owner = connection.id;
    const session = new TranslationSession(
      this.env.GRADIUM_API_KEY,
      (message) => {
        // A replaced session cannot send events into the current recording.
        if (this.#session === session) connection.send(JSON.stringify(message));
      }
    );
    this.#session = session;
    return session.connect(targetLanguage, voiceId);
  }

  @callable()
  async stopTranslation() {
    if (getCurrentAgent().connection?.id === this.#owner) this.#closeSession();
  }

  onClose(connection: Connection) {
    if (connection.id === this.#owner) this.#closeSession();
  }

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    if (connection.id !== this.#owner || typeof data !== "string") return;
    try {
      const message: unknown = JSON.parse(data);
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "audio-chunk" &&
        "data" in message &&
        typeof message.data === "string"
      )
        this.#session?.feed(message.data);
    } catch {
      // Ignore malformed client frames.
    }
  }

  #closeSession() {
    this.#session?.close();
    this.#session = null;
    this.#owner = undefined;
  }
}
