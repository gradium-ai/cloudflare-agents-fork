import { vi } from "vitest";

export class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function connectWith(socket = new MockWebSocket()) {
  const fetchMock = vi.fn(
    async () => ({ webSocket: socket, status: 101 }) as unknown as Response
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, socket };
}

export function message(socket: MockWebSocket, data: Record<string, unknown>) {
  socket.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

export function sentMessages(
  socket: MockWebSocket
): Array<Record<string, unknown>> {
  return socket.send.mock.calls.map(([value]) => JSON.parse(String(value)));
}

export function closeSocket(socket: MockWebSocket, code = 1006, reason = "") {
  const event = new Event("close");
  Object.assign(event, { code, reason });
  socket.dispatchEvent(event);
}
