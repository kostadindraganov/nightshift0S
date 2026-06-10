// React hook that tails GET /events/stream via fetch + ReadableStream.
// We use fetch (not EventSource) because EventSource cannot send custom headers,
// and we need the Authorization header for bearer auth.
import { useEffect, useRef, useState } from "react";
import { getToken } from "./api.ts";
import type { NightshiftEvent } from "./types.ts";

export interface EventStreamStatus {
  connected: boolean;
}

export function useEventStream(
  onEvent: (e: NightshiftEvent) => void,
  opts?: { afterSeq?: number }
): EventStreamStatus {
  const [connected, setConnected] = useState(false);
  // Keep onEvent stable across re-renders so the stream does not reconnect.
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const afterSeqRef = useRef(opts?.afterSeq ?? 0);

  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();

    async function connect(): Promise<void> {
      const seq = afterSeqRef.current;
      try {
        const res = await fetch(`/events/stream?after_seq=${seq}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
          signal: controller.signal,
        });

        if (!res.ok || res.body === null) {
          setConnected(false);
          scheduleReconnect();
          return;
        }

        setConnected(true);

        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE events are delimited by double newline.
          const parts = buf.split("\n\n");
          // Keep the last (potentially incomplete) chunk in the buffer.
          buf = parts.pop() ?? "";

          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  const evt = JSON.parse(line.slice(6)) as NightshiftEvent;
                  afterSeqRef.current = Math.max(afterSeqRef.current, evt.seq);
                  onEventRef.current(evt);
                } catch {
                  // malformed JSON — skip
                }
              }
              // Ignore ": " heartbeat/comment lines.
            }
          }
        }

        setConnected(false);
        scheduleReconnect();
      } catch (err) {
        if (aborted) return;
        setConnected(false);
        scheduleReconnect();
      }
    }

    function scheduleReconnect(): void {
      if (aborted) return;
      setTimeout(() => {
        if (!aborted) void connect();
      }, 2000);
    }

    void connect();

    return () => {
      aborted = true;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — reconnect loop manages itself

  return { connected };
}
