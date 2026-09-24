import { afterEach, expect, it, vi } from "vitest";
import { GradiumSTT } from "../src/index";
import {
  MockWebSocket,
  closeSocket,
  connectWith,
  flush,
  message,
  sentMessages
} from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("defaults the STT language to automatic detection", async () => {
  const { socket } = connectWith();
  new GradiumSTT({ apiKey: "test-key" }).createSession();
  await flush();

  expect(sentMessages(socket)[0]).toMatchObject({
    type: "setup",
    json_config: { language: "any" }
  });
});

it("overrides the STT language per session without changing provider defaults", async () => {
  const provider = new GradiumSTT({
    apiKey: "test-key",
    language: "en",
    jsonConfig: { language: "de" }
  });
  const { socket: frenchSocket } = connectWith();
  const french = provider.createSession({ language: "fr" });
  await flush();
  expect(sentMessages(frenchSocket)[0]).toMatchObject({
    json_config: { language: "fr" }
  });

  const { socket: defaultSocket } = connectWith();
  const defaultSession = provider.createSession();
  await flush();
  expect(sentMessages(defaultSocket)[0]).toMatchObject({
    json_config: { language: "en" }
  });
  french.close();
  defaultSession.close();
});

it.each([
  { language: "fr", expected: "fr" },
  { language: undefined, expected: "de" }
])(
  "resolves JSON language with session language $language",
  async ({ language, expected }) => {
    const { socket } = connectWith();
    const jsonConfig = { language: "de" };
    const session = new GradiumSTT({
      apiKey: "test-key",
      jsonConfig
    }).createSession({ language });
    await flush();
    expect(sentMessages(socket)[0]).toMatchObject({
      json_config: { language: expected }
    });
    expect(jsonConfig.language).toBe("de");
    session.close();
  }
);

it("sends STT setup and holds audio until Gradium is ready", async () => {
  const { socket } = connectWith();
  const session = new GradiumSTT({
    apiKey: "test-key",
    language: "fr",
    temperature: 0.2,
    delayInFrames: 6,
    paddingBonus: 1.5
  }).createSession();
  session.feed(new Uint8Array([1, 2]).buffer);
  await flush();

  expect(sentMessages(socket)).toEqual([
    {
      type: "setup",
      model_name: "default",
      input_format: "pcm_16000",
      json_config: {
        language: "fr",
        temp: 0.2,
        delay_in_frames: 6,
        padding_bonus: 1.5
      }
    }
  ]);

  message(socket, { type: "ready" });
  await expect(session.waitUntilReady?.()).resolves.toBeUndefined();
  expect(sentMessages(socket)[1]).toEqual({
    type: "audio",
    audio: btoa(String.fromCharCode(1, 2))
  });
  session.close();
});

it("uses semantic VAD and flushes one complete utterance", async () => {
  const { socket } = connectWith();
  const onSpeechStart = vi.fn();
  const onInterim = vi.fn();
  const onUtterance = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onSpeechStart,
    onInterim,
    onUtterance
  });
  await flush();
  message(socket, { type: "ready" });

  message(socket, { type: "text", text: "Hello" });
  message(socket, { type: "text", text: "," });
  message(socket, { type: "text", text: "world" });
  message(socket, {
    type: "step",
    vad: [
      { horizon_s: 1, inactivity_prob: 0.9 },
      { horizon_s: 2, inactivity_prob: 0.6 },
      { horizon_s: 3, inactivity_prob: 0.2 }
    ]
  });

  expect(onSpeechStart).toHaveBeenCalledTimes(1);
  expect(onInterim).toHaveBeenLastCalledWith("Hello, world");
  expect(sentMessages(socket).at(-1)).toEqual({ type: "flush", flush_id: 1 });

  message(socket, { type: "text", text: "today" });
  message(socket, { type: "flushed", flush_id: 1 });
  expect(onUtterance).toHaveBeenCalledWith("Hello, world today");

  // Speech start re-arms for the next utterance, once it clears minSpeechWords.
  message(socket, { type: "text", text: "Next" });
  expect(onSpeechStart).toHaveBeenCalledTimes(1);
  message(socket, { type: "text", text: "question" });
  expect(onSpeechStart).toHaveBeenCalledTimes(2);
  session.close();
});

it("commits the utterance when the flush ack omits flush_id", async () => {
  const { socket } = connectWith();
  const onUtterance = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onUtterance
  });
  await flush();
  message(socket, { type: "ready" });
  message(socket, { type: "text", text: "Hello" });
  message(socket, {
    type: "vad",
    vad: [{ horizon_s: 2, inactivity_prob: 0.9 }]
  });
  message(socket, { type: "flushed" });

  expect(onUtterance).toHaveBeenCalledWith("Hello");
  session.close();
});

it("rejects readiness and reports a fatal error when Gradium reports an error", async () => {
  const { socket } = connectWith();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "Gradium STT server error"
  );
  await flush();

  message(socket, { type: "error", message: "unknown model" });
  await readiness;
  expect(onFatalError).toHaveBeenCalledTimes(1);
  // Provider message text must not leak into the error.
  expect(onFatalError.mock.calls[0][0].message).not.toContain("unknown model");
  session.close();
});

it("reports an unsolicited STT socket close as a fatal error", async () => {
  const { socket } = connectWith();
  const onFatalError = vi.fn();
  new GradiumSTT({ apiKey: "test-key" }).createSession({ onFatalError });
  await flush();
  message(socket, { type: "ready" });
  closeSocket(socket, 1011, "upstream failure");

  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(onFatalError.mock.calls[0][0]).toMatchObject({
    closeCode: 1011,
    closeReason: "upstream failure"
  });
});

it("does not report a fatal error for teardown initiated by close()", async () => {
  const { socket } = connectWith();
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });
  await flush();
  message(socket, { type: "ready" });
  session.close();
  closeSocket(socket, 1000, "");

  expect(onFatalError).not.toHaveBeenCalled();
});

it("waits for enough words before reporting speech start", async () => {
  const { socket } = connectWith();
  const onSpeechStart = vi.fn();
  const onInterim = vi.fn();
  const session = new GradiumSTT({
    apiKey: "test-key",
    minSpeechWords: 3
  }).createSession({ onSpeechStart, onInterim });
  await flush();
  message(socket, { type: "ready" });

  message(socket, { type: "text", text: "Okay" });
  expect(onInterim).toHaveBeenLastCalledWith("Okay");
  expect(onSpeechStart).not.toHaveBeenCalled();

  message(socket, { type: "text", text: "so" });
  expect(onSpeechStart).not.toHaveBeenCalled();

  message(socket, { type: "text", text: "anyway" });
  expect(onSpeechStart).toHaveBeenCalledTimes(1);
  expect(onSpeechStart).toHaveBeenCalledWith("Okay so anyway");
  session.close();
});

it("still flushes a short utterance that never reported speech start", async () => {
  const { socket } = connectWith();
  const onUtterance = vi.fn();
  const session = new GradiumSTT({
    apiKey: "test-key",
    minSpeechWords: 5
  }).createSession({ onUtterance });
  await flush();
  message(socket, { type: "ready" });

  message(socket, { type: "text", text: "Yes" });
  message(socket, {
    type: "vad",
    vad: [{ horizon_s: 2, inactivity_prob: 0.9 }]
  });
  message(socket, { type: "flushed", flush_id: 1 });

  expect(onUtterance).toHaveBeenCalledWith("Yes");
  session.close();
});

it("does not flush below the configured VAD threshold", async () => {
  const { socket } = connectWith();
  const session = new GradiumSTT({
    apiKey: "test-key",
    vadHorizonSeconds: 1,
    vadThreshold: 0.8
  }).createSession();
  await flush();
  message(socket, { type: "ready" });
  message(socket, { type: "text", text: "Still speaking" });
  message(socket, {
    type: "vad",
    vad: [{ horizon_s: 1, inactivity_prob: 0.79 }]
  });

  expect(sentMessages(socket).some((value) => value.type === "flush")).toBe(
    false
  );
  session.close();
});

it("caps audio buffered while the STT connection is pending", async () => {
  const socket = new MockWebSocket();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const session = new GradiumSTT({ apiKey: "test-key" }).createSession();
  for (let index = 0; index < 31; index++) {
    session.feed(new ArrayBuffer(32_000));
  }
  resolveFetch({ webSocket: socket, status: 101 } as unknown as Response);
  await flush();
  message(socket, { type: "ready" });

  expect(
    sentMessages(socket).filter((value) => value.type === "audio")
  ).toHaveLength(30);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith(
    expect.objectContaining({ component: "GradiumSTT", stage: "audio_buffer" })
  );
  session.close();
});

it("rejects readiness when closed while the STT connection is pending", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {}))
  );
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession();
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "GradiumSTT: WebSocket closed before session start."
  );
  session.close();
  await readiness;
});

it("converts a local ws URL for the WebSocket fetch upgrade", async () => {
  const { fetchMock, socket } = connectWith();
  const session = new GradiumSTT({
    apiKey: "test-key",
    baseUrl: "ws://localhost:8787/speech/asr"
  }).createSession();
  await flush();

  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:8787/speech/asr",
    expect.any(Object)
  );
  message(socket, { type: "ready" });
  session.close();
});

it("handles STT errors emitted during socket acceptance", async () => {
  const { socket } = connectWith();
  vi.spyOn(console, "error").mockImplementation(() => {});
  socket.accept.mockImplementation(() => message(socket, { type: "error" }));
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });

  await expect(session.waitUntilReady?.()).rejects.toThrow(
    "Gradium STT server error"
  );
  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("releases STT resources when socket acceptance fails", async () => {
  const { socket } = connectWith();
  const remove = vi.spyOn(socket, "removeEventListener");
  vi.spyOn(console, "error").mockImplementation(() => {});
  socket.accept.mockImplementation(() => {
    throw new Error("accept failed");
  });
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });

  await expect(session.waitUntilReady?.()).rejects.toThrow("accept failed");
  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
    "close",
    "error",
    "message"
  ]);
});

it("makes an STT provider failure terminal before notifying the caller", async () => {
  const { socket } = connectWith();
  const remove = vi.spyOn(socket, "removeEventListener");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onInterim = vi.fn();
  const onUtterance = vi.fn();
  const onFatalError = vi.fn(() => {
    expect(socket.close).toHaveBeenCalledTimes(1);
    session.feed(new ArrayBuffer(2));
    session.close();
  });
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onInterim,
    onUtterance,
    onFatalError
  });
  await flush();
  message(socket, { type: "ready" });
  await session.waitUntilReady?.();
  message(socket, { type: "text", text: "unfinished" });
  const sendsBeforeFailure = socket.send.mock.calls.length;
  message(socket, { type: "error" });
  message(socket, { type: "text", text: "late" });
  message(socket, { type: "end_of_stream" });
  socket.dispatchEvent(new Event("error"));
  closeSocket(socket);

  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(onInterim).toHaveBeenCalledTimes(1);
  expect(onUtterance).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenCalledTimes(sendsBeforeFailure);
  expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
    "close",
    "error",
    "message"
  ]);
});

it("rejects STT readiness when sending setup fails", async () => {
  const { socket } = connectWith();
  vi.spyOn(console, "error").mockImplementation(() => {});
  socket.send.mockImplementation(() => {
    throw new Error("setup failed");
  });
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });

  await expect(session.waitUntilReady?.()).rejects.toThrow("setup failed");
  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("rejects STT readiness and stops draining buffered audio if a send fails", async () => {
  const { socket } = connectWith();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });
  session.feed(new ArrayBuffer(2));
  session.feed(new ArrayBuffer(2));
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "audio failed"
  );
  await flush();
  socket.send.mockImplementation(() => {
    throw new Error("audio failed");
  });
  message(socket, { type: "ready" });
  await readiness;

  expect(socket.send).toHaveBeenCalledTimes(2); // setup + first buffered chunk
  expect(onFatalError).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it.each(["audio", "flush"])(
  "treats a failed STT %s send as terminal",
  async (kind) => {
    const { socket } = connectWith();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFatalError = vi.fn();
    const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
      onFatalError
    });
    await flush();
    message(socket, { type: "ready" });
    await session.waitUntilReady?.();
    socket.send.mockImplementation(() => {
      throw new Error("send failed");
    });
    if (kind === "audio") {
      expect(() => session.feed(new ArrayBuffer(2))).not.toThrow();
    } else {
      message(socket, { type: "text", text: "hello" });
      message(socket, {
        type: "vad",
        vad: [{ horizon_s: 2, inactivity_prob: 0.9 }]
      });
    }
    session.feed(new ArrayBuffer(2));
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.close).toHaveBeenCalledTimes(1);
  }
);

it("aborts an in-flight STT upgrade on close without reporting a failure", async () => {
  let upgradeSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      upgradeSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upgradeSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    })
  );
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "closed before session start"
  );
  session.close();
  await readiness;
  await flush();

  expect(upgradeSignal?.aborted).toBe(true);
  expect(onFatalError).not.toHaveBeenCalled();
  expect(errorLog).not.toHaveBeenCalled();
});

it("closes a late STT upgrade without sending setup or buffered audio", async () => {
  const socket = new MockWebSocket();
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    )
  );
  const onFatalError = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError
  });
  session.feed(new ArrayBuffer(2));
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "closed before session start"
  );
  session.close();
  resolveFetch({ webSocket: socket, status: 101 } as unknown as Response);
  await readiness;
  await flush();

  expect(socket.accept).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.send).not.toHaveBeenCalled();
  expect(onFatalError).not.toHaveBeenCalled();
});

it("keeps STT close idempotent when both teardown send and socket close throw", async () => {
  const { socket } = connectWith();
  const onFatalError = vi.fn();
  const onInterim = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onFatalError,
    onInterim
  });
  await flush();
  message(socket, { type: "ready" });
  await session.waitUntilReady?.();
  socket.send.mockImplementation(() => {
    throw new Error("send failed");
  });
  socket.close.mockImplementation(() => {
    throw new Error("close failed");
  });

  expect(() => session.close()).not.toThrow();
  expect(() => session.close()).not.toThrow();
  message(socket, { type: "text", text: "late" });
  expect(onInterim).not.toHaveBeenCalled();
  expect(onFatalError).not.toHaveBeenCalled();
  expect(socket.send).toHaveBeenCalledTimes(2);
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("does not emit an interim transcript after onSpeechStart closes STT", async () => {
  const { socket } = connectWith();
  const onInterim = vi.fn();
  const session = new GradiumSTT({ apiKey: "test-key" }).createSession({
    onSpeechStart: () => session.close(),
    onInterim
  });
  await flush();
  message(socket, { type: "ready" });
  message(socket, { type: "text", text: "hello world" });
  expect(onInterim).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledTimes(1);
});
