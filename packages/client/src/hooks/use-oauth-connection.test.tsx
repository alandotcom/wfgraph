import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orpcQuery } from "#src/lib/rpc-query";
import { useOAuthConnection } from "./use-oauth-connection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function popup() {
  return {
    closed: false,
    opener: null,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useOAuthConnection", () => {
  it("owns and closes the reserved popup when unmounted during start", async () => {
    const start = deferred<Response>();
    const reservedPopup = popup();
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    vi.spyOn(globalThis, "fetch").mockReturnValue(start.promise);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const onConnected = vi.fn();
    const owner = renderHook(() => useOAuthConnection({ onConnected }), {
      wrapper,
    });

    let attempt!: Promise<void>;
    act(() => {
      attempt = owner.result.current.startCreated({
        name: "Production",
        type: "resend",
        config: {},
      });
    });
    expect(window.open).toHaveBeenCalledOnce();

    owner.unmount();

    expect(reservedPopup.close).toHaveBeenCalledOnce();
    start.resolve(
      jsonResponse({
        attemptId: "attempt_1",
        authorizeUrl: "https://provider.example/authorize",
      })
    );
    await attempt;
    expect(reservedPopup.location.assign).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("does not notify after cancellation during the terminal cache refresh", async () => {
    const reservedPopup = popup();
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          attemptId: "attempt_1",
          authorizeUrl: "https://provider.example/authorize",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "succeeded",
          integrationId: "connection_1",
        })
      );
    const refresh = deferred<void>();
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(refresh.promise);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const onConnected = vi.fn();
    const owner = renderHook(() => useOAuthConnection({ onConnected }), {
      wrapper,
    });

    let attempt!: Promise<void>;
    act(() => {
      attempt = owner.result.current.startExisting("connection_1");
    });
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(2));

    owner.unmount();
    refresh.resolve();
    await attempt;

    expect(onConnected).not.toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: orpcQuery.integration.configOptions.key({
        input: { integrationId: "connection_1" },
      }),
    });
  });

  it("releases the controller for retry after the provider popup closes", async () => {
    vi.useFakeTimers();
    const reservedPopup = popup();
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          attemptId: "attempt_1",
          authorizeUrl: "https://provider.example/authorize",
        })
      )
      .mockImplementation(async () => jsonResponse({ status: "pending" }));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const onConnected = vi.fn();
    const { result } = renderHook(() => useOAuthConnection({ onConnected }), {
      wrapper,
    });

    let attempt!: Promise<void>;
    act(() => {
      attempt = result.current.startExisting("connection_1");
    });
    reservedPopup.closed = true;
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await attempt;

    expect(result.current.pending).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("cancels a superseded attempt and only reports the current success", async () => {
    const firstPopup = popup();
    const secondPopup = popup();
    vi.spyOn(window, "open")
      .mockReturnValueOnce(firstPopup as unknown as Window)
      .mockReturnValueOnce(secondPopup as unknown as Window);
    const firstStart = deferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstStart.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          attemptId: "attempt_2",
          authorizeUrl: "https://provider.example/authorize",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "succeeded",
          integrationId: "connection_2",
        })
      );
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const onConnected = vi.fn();
    const { result } = renderHook(() => useOAuthConnection({ onConnected }), {
      wrapper,
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.startExisting("connection_1");
      second = result.current.startExisting("connection_2");
    });
    // This case keeps the hook mounted, where the ones that unmount first do
    // not. The superseded attempt's cancellation and the winner's success both
    // settle inside this scope.
    await act(async () => {
      await second;
      firstStart.resolve(
        jsonResponse({
          attemptId: "attempt_1",
          authorizeUrl: "https://provider.example/authorize",
        })
      );
      await first;
    });

    expect(firstPopup.close).toHaveBeenCalledOnce();
    expect(firstPopup.location.assign).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onConnected).toHaveBeenCalledWith("connection_2");
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: orpcQuery.integration.configOptions.key({
        input: { integrationId: "connection_2" },
      }),
    });
  });

  it("refreshes a failed reconnect's provider options for that connection", async () => {
    const reservedPopup = popup();
    vi.spyOn(window, "open").mockReturnValue(
      reservedPopup as unknown as Window
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          attemptId: "attempt_1",
          authorizeUrl: "https://provider.example/authorize",
        })
      )
      .mockResolvedValueOnce(jsonResponse({ status: "failed" }));
    const queryClient = new QueryClient();
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useOAuthConnection({ onConnected: vi.fn() }),
      { wrapper }
    );

    await act(() => result.current.startExisting("connection_1"));

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: orpcQuery.integration.configOptions.key({
        input: { integrationId: "connection_1" },
      }),
    });
  });
});
