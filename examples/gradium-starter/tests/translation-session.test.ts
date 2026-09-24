import { afterEach, expect, it, vi } from "vitest";
import { TranslationSession } from "../src/lib/translation-session";

class Socket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  removeEventListener = vi.fn(super.removeEventListener.bind(this));
  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) })
    );
  }
}

function response(socket: Socket): Response {
  return { webSocket: socket, status: 101 } as unknown as Response;
}

function pendingResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(socket = new Socket()) {
  const fetchMock = vi.fn(async () => response(socket));
  vi.stubGlobal("fetch", fetchMock);
  const send = vi.fn();
  const session = new TranslationSession("test-key", send);
  return { session, socket, send, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

it("waits for ready before forwarding audio and closes once", async () => {
  const { session, socket, send } = setup();
  expect(await session.connect("fr", "voice")).toBe(true);
  session.feed("before-ready");
  expect(socket.send).toHaveBeenCalledTimes(1);
  socket.message({ type: "ready", sample_rate: 48000 });
  socket.message({ type: "ready", sample_rate: 48000 });
  session.feed("audio");
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "audio", audio: "audio" })
  );
  expect(send).toHaveBeenCalledTimes(1);
  socket.message({ type: "text", text: "Bonjour" });
  socket.message({ type: "audio", audio: "AAAA" });
  expect(send).toHaveBeenLastCalledWith({
    type: "translation-audio",
    audio: "AAAA"
  });
  session.close();
  session.close();
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "end_of_stream" })
  );
  expect(socket.removeEventListener).toHaveBeenCalledTimes(3);
  socket.dispatchEvent(new Event("close"));
  expect(send).not.toHaveBeenCalledWith({ type: "translation-error" });
});

it("releases an upgrade that resolves after cancellation", async () => {
  const { session, socket, fetchMock, send } = setup();
  const pending = pendingResponse();
  fetchMock.mockReturnValueOnce(pending.promise);
  const connecting = session.connect("fr", "voice");
  const signal = (
    fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  )[1].signal;
  session.close();
  expect(signal?.aborted).toBe(true);
  pending.resolve(response(socket));
  expect(await connecting).toBe(false);
  expect(socket.accept).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(socket.send).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("keeps a replacement session alive when the old upgrade finishes", async () => {
  const old = setup();
  const pending = pendingResponse();
  old.fetchMock.mockReturnValueOnce(pending.promise);
  const first = old.session.connect("fr", "first");
  old.session.close();
  const next = setup();
  await next.session.connect("en", "second");
  next.socket.message({ type: "ready" });
  pending.resolve(response(old.socket));
  await first;
  old.socket.dispatchEvent(new Event("close"));
  next.session.feed("audio");
  expect(next.socket.close).not.toHaveBeenCalled();
  expect(next.socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "audio", audio: "audio" })
  );
  next.session.close();
});

it.each(["error", "close"])(
  "reports a socket %s once and releases listeners",
  async (type) => {
    const { session, socket, send } = setup();
    await session.connect("fr", "voice");
    socket.dispatchEvent(new Event(type));
    socket.dispatchEvent(new Event(type));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-error" });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.removeEventListener).toHaveBeenCalledTimes(3);
    session.feed("late");
    expect(socket.send).toHaveBeenCalledTimes(1);
  }
);

it("ignores malformed frames and handles provider errors without exposing their text", async () => {
  const { session, socket, send } = setup();
  await session.connect("fr", "voice");
  socket.dispatchEvent(new MessageEvent("message", { data: "{" }));
  for (const value of [
    null,
    42,
    { type: "text", text: {} },
    { type: "audio", audio: [] }
  ])
    socket.message(value);
  expect(send).not.toHaveBeenCalled();
  socket.message({ type: "error", message: "private details" });
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-error" });
  expect(socket.close).toHaveBeenCalledOnce();
});

it("handles an error during accept without sending setup", async () => {
  const { session, socket, send } = setup();
  socket.accept.mockImplementation(() =>
    socket.dispatchEvent(new Event("error"))
  );
  expect(await session.connect("fr", "voice")).toBe(false);
  expect(socket.send).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-error" });
});

it("handles a throwing accept and throwing close", async () => {
  const { session, socket, send } = setup();
  socket.accept.mockImplementation(() => {
    throw new Error("accept failed");
  });
  socket.close.mockImplementation(() => {
    throw new Error("close failed");
  });
  expect(await session.connect("fr", "voice")).toBe(false);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-error" });
  expect(socket.removeEventListener).toHaveBeenCalledTimes(3);
});

it("closes even when sending audio or end_of_stream fails", async () => {
  const { session, socket, send } = setup();
  await session.connect("fr", "voice");
  socket.message({ type: "ready" });
  send.mockClear();
  socket.send.mockImplementation(() => {
    throw new Error("send failed");
  });
  session.feed("audio");
  expect(socket.close).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-error" });
});

it("reports failed upgrades and suppresses cancelled fetch failures", async () => {
  const first = setup();
  first.fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(await first.session.connect("fr", "voice")).toBe(false);
  expect(first.send).toHaveBeenCalledExactlyOnceWith({
    type: "translation-error"
  });
  const next = setup();
  const pending = pendingResponse();
  next.fetchMock.mockReturnValueOnce(pending.promise);
  const connecting = next.session.connect("fr", "voice");
  next.session.close();
  pending.reject(new Error("aborted"));
  expect(await connecting).toBe(false);
  expect(next.send).not.toHaveBeenCalled();
});

it("reports normal provider completion and releases the socket", async () => {
  const { session, socket, send } = setup();
  await session.connect("fr", "voice");
  socket.message({ type: "end_of_stream" });
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "translation-stopped" });
  expect(socket.close).toHaveBeenCalledOnce();
});
