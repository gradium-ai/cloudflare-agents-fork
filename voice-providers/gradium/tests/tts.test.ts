import { afterEach, expect, it, vi } from "vitest";
import { GradiumTTS } from "../src/index";
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

it("streams Gradium TTS audio after the ready message", async () => {
  const { fetchMock, socket } = connectWith();
  const tts = new GradiumTTS({
    apiKey: "test-key",
    voiceId: "voice-123"
  });
  const iterator = tts.synthesizeStream("Hello world");
  const firstChunk = iterator.next();
  await flush();

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.gradium.ai/api/speech/tts",
    expect.objectContaining({
      headers: { Upgrade: "websocket", "x-api-key": "test-key" }
    })
  );
  expect(sentMessages(socket)[0]).toEqual({
    type: "setup",
    model_name: "default",
    voice_id: "voice-123",
    output_format: "pcm",
    json_config: {}
  });

  message(socket, { type: "ready" });
  await flush();
  expect(sentMessages(socket).slice(1)).toEqual([
    { type: "text", text: "Hello world" },
    { type: "end_of_stream" }
  ]);

  message(socket, {
    type: "audio",
    audio: btoa(String.fromCharCode(1, 2, 3, 4))
  });
  expect(new Uint8Array((await firstChunk).value)).toEqual(
    new Uint8Array([1, 2, 3, 4])
  );

  const done = iterator.next();
  message(socket, { type: "end_of_stream" });
  await expect(done).resolves.toEqual({ done: true, value: undefined });
  expect(socket.close).toHaveBeenCalled();
});

it("ignores word-timestamp messages in the TTS audio stream", async () => {
  const { socket } = connectWith();
  const tts = new GradiumTTS({ apiKey: "test-key" });
  const iterator = tts.synthesizeStream("Hello world");
  const first = iterator.next();
  await flush();
  message(socket, { type: "ready" });
  await flush();

  // Gradium interleaves word-aligned text with audio; only audio is yielded.
  message(socket, { type: "text", text: "Hello", start_s: 0.24, stop_s: 0.48 });
  message(socket, { type: "audio", audio: btoa("ab") });
  expect(new TextDecoder().decode((await first).value)).toBe("ab");

  const done = iterator.next();
  message(socket, { type: "end_of_stream" });
  await expect(done).resolves.toEqual({ done: true, value: undefined });
});

it("fails the TTS stream when the socket closes before end_of_stream", async () => {
  const { socket } = connectWith();
  const tts = new GradiumTTS({ apiKey: "test-key" });
  const iterator = tts.synthesizeStream("Hello");
  const first = iterator.next();
  await flush();

  message(socket, { type: "ready" });
  closeSocket(socket, 1008, "invalid api key");

  await expect(first).rejects.toThrow(
    "GradiumTTS: WebSocket closed before end_of_stream."
  );
});

it("combines streamed TTS chunks for synthesize", async () => {
  const { socket } = connectWith();
  const tts = new GradiumTTS({ apiKey: "test-key" });
  const audio = tts.synthesize("Hello");
  await flush();

  message(socket, { type: "ready" });
  message(socket, { type: "audio", audio: btoa("ab") });
  message(socket, { type: "audio", audio: btoa("cd") });
  message(socket, { type: "end_of_stream" });

  expect(new TextDecoder().decode((await audio) ?? undefined)).toBe("abcd");
});

it("cancels a waiting TTS read even when close throws and emits no event", async () => {
  const { socket } = connectWith();
  socket.close.mockImplementation(() => {
    throw new Error("already closed");
  });
  const abort = new AbortController();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello",
    abort.signal
  );
  const pending = stream.next();
  await flush();
  abort.abort();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("discards buffered TTS audio on abort", async () => {
  const { socket } = connectWith();
  const abort = new AbortController();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello",
    abort.signal
  );
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  message(socket, { type: "audio", audio: btoa("cd") });
  abort.abort();
  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});

it("closes a TTS connection when aborted during its upgrade", async () => {
  const socket = new MockWebSocket();
  const abort = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      abort.abort();
      return { webSocket: socket, status: 101 } as unknown as Response;
    })
  );
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello",
    abort.signal
  );
  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("drains queued TTS audio in order after end_of_stream", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  message(socket, { type: "audio", audio: btoa("cd") });
  message(socket, { type: "audio", audio: btoa("ef") });
  message(socket, { type: "end_of_stream" });
  expect(socket.close).toHaveBeenCalledTimes(1);
  for (const expected of ["cd", "ef"]) {
    expect(new TextDecoder().decode((await stream.next()).value)).toBe(
      expected
    );
  }
  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});

it("fails TTS at the byte budget instead of delivering buffered audio after overflow", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({
    apiKey: "test-key",
    maxBufferedAudioBytes: 4
  }).synthesizeStream("Hello");
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  message(socket, { type: "audio", audio: btoa("abcd") });
  expect(socket.close).not.toHaveBeenCalled();
  message(socket, { type: "audio", audio: btoa("ef") });
  expect(socket.close).toHaveBeenCalledTimes(1);
  await expect(stream.next()).rejects.toMatchObject({
    code: "audio_buffer_overflow"
  });
});

it("reclaims the TTS byte budget as the consumer reads", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({
    apiKey: "test-key",
    maxBufferedAudioBytes: 4
  }).synthesizeStream("Hello");
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  for (const chunk of ["abcd", "efgh", "ijkl"]) {
    message(socket, { type: "audio", audio: btoa(chunk) });
    expect(new TextDecoder().decode((await stream.next()).value)).toBe(chunk);
  }
  message(socket, { type: "end_of_stream" });
  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});

it("rejects a waiting TTS read on invalid base64 and removes listeners", async () => {
  const { socket } = connectWith();
  const remove = vi.spyOn(socket, "removeEventListener");
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const pending = stream.next();
  await flush();
  message(socket, { type: "audio", audio: "!invalid!" });
  await expect(pending).rejects.toMatchObject({ code: "message_error" });
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
    "close",
    "error",
    "message"
  ]);
  message(socket, { type: "audio", audio: btoa("late") });
});

it("cleans up TTS when the setup send throws", async () => {
  const { socket } = connectWith();
  socket.send.mockImplementation(() => {
    throw new Error("send failed");
  });
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  await expect(stream.next()).rejects.toThrow("send failed");
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("closes TTS when the consumer stops early", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  message(socket, { type: "audio", audio: btoa("cd") });
  await stream.return(undefined);
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("rejects invalid TTS buffer budgets", () => {
  for (const maxBufferedAudioBytes of [0, -1, 1.5, NaN, Infinity]) {
    expect(
      () => new GradiumTTS({ apiKey: "test-key", maxBufferedAudioBytes })
    ).toThrow(RangeError);
  }
});

it("discards queued TTS audio when the provider reports an error", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const first = stream.next();
  await flush();
  message(socket, { type: "audio", audio: btoa("ab") });
  await first;
  message(socket, { type: "audio", audio: btoa("cd") });
  message(socket, { type: "error", message: "private provider payload" });
  await expect(stream.next()).rejects.toThrow("Gradium TTS server error");
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("rejects a pending TTS read when sending text after ready fails", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const pending = stream.next();
  await flush();
  socket.send.mockImplementation(() => {
    throw new Error("send failed");
  });
  message(socket, { type: "ready" });
  await expect(pending).rejects.toMatchObject({ code: "message_error" });
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("handles socket events emitted during acceptance before sending setup", async () => {
  const { socket } = connectWith();
  socket.accept.mockImplementation(() => {
    message(socket, { type: "error", message: "private provider detail" });
  });
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );

  await expect(stream.next()).rejects.toThrow("Gradium TTS server error");
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("cleans up TTS when accepting the socket throws", async () => {
  const { socket } = connectWith();
  const remove = vi.spyOn(socket, "removeEventListener");
  socket.accept.mockImplementation(() => {
    throw new Error("accept failed");
  });
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );

  await expect(stream.next()).rejects.toThrow("accept failed");
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls.map(([type]) => type).sort()).toEqual([
    "close",
    "error",
    "message"
  ]);
});

it("returns null rather than partial audio when collected synthesis is aborted", async () => {
  const { socket } = connectWith();
  const abort = new AbortController();
  const result = new GradiumTTS({ apiKey: "test-key" }).synthesize(
    "Hello",
    abort.signal
  );
  await flush();
  message(socket, { type: "audio", audio: btoa("partial") });
  await flush();
  abort.abort();

  await expect(result).resolves.toBeNull();
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it("ends TTS iteration normally when an aborted upgrade rejects", async () => {
  const abort = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      abort.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    })
  );
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello",
    abort.signal
  );

  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});

it("sends text only once if Gradium repeats ready", async () => {
  const { socket } = connectWith();
  const stream = new GradiumTTS({ apiKey: "test-key" }).synthesizeStream(
    "Hello"
  );
  const pending = stream.next();
  await flush();
  message(socket, { type: "ready" });
  message(socket, { type: "ready" });

  expect(sentMessages(socket).filter(({ type }) => type === "text")).toEqual([
    { type: "text", text: "Hello" }
  ]);
  message(socket, { type: "end_of_stream" });
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
});

it("isolates the lifecycle of simultaneous TTS requests", async () => {
  const firstSocket = new MockWebSocket();
  const secondSocket = new MockWebSocket();
  const { fetchMock } = connectWith(firstSocket);
  fetchMock.mockResolvedValueOnce({
    webSocket: firstSocket,
    status: 101
  } as unknown as Response);
  fetchMock.mockResolvedValueOnce({
    webSocket: secondSocket,
    status: 101
  } as unknown as Response);
  const tts = new GradiumTTS({ apiKey: "test-key" });
  const abort = new AbortController();
  const first = tts.synthesizeStream("First", abort.signal).next();
  const secondStream = tts.synthesizeStream("Second");
  const second = secondStream.next();
  await flush();

  abort.abort();
  await expect(first).resolves.toEqual({ done: true, value: undefined });
  expect(secondSocket.close).not.toHaveBeenCalled();
  message(secondSocket, { type: "audio", audio: btoa("ab") });
  expect(new TextDecoder().decode((await second).value)).toBe("ab");
  message(secondSocket, { type: "end_of_stream" });
  await expect(secondStream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});
