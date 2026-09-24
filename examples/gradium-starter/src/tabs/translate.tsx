import { useAgent } from "agents/react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import {
  MicrophoneIcon,
  StopCircleIcon,
  TranslateIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionId } from "../lib/session-id";

/** Gradium s2s input is 24 kHz PCM; output is 48 kHz (reported by the session). */
const CAPTURE_SAMPLE_RATE = 24_000;
const DEFAULT_PLAYBACK_SAMPLE_RATE = 48_000;

interface CatalogVoice {
  id: string;
  name: string;
  country: string;
}

/**
 * Target languages with the top three Gradium voices for each. The s2s setup's
 * `voice_id` must match a voice in the target language, so the picker resets
 * whenever the language changes.
 */
const LANGUAGES: Array<{
  code: string;
  label: string;
  flag: string;
  voices: CatalogVoice[];
}> = [
  {
    code: "en",
    label: "English",
    flag: "🇬🇧",
    voices: [
      { id: "4SZHfMpw-p46Ywgs", name: "Harper", country: "us" },
      { id: "D6COLz20Hw7uh3UK", name: "Brooklyn", country: "us" },
      { id: "Bla6SbVMczYnOhfK", name: "Marlowe", country: "us" }
    ]
  },
  {
    code: "fr",
    label: "French",
    flag: "🇫🇷",
    voices: [
      { id: "ZeSg853xFACESHHI", name: "Coralie", country: "fr" },
      { id: "YhIHaAfQ0cQPDV9R", name: "Solène", country: "fr" },
      { id: "iEu63s1rhn_kegTr", name: "Gaspard", country: "fr" }
    ]
  },
  {
    code: "es",
    label: "Spanish",
    flag: "🇪🇸",
    voices: [
      { id: "b6FvJAiokjdqIti4", name: "Noa", country: "es" },
      { id: "iTQW2xFICXk8riV4", name: "Vera", country: "es" },
      { id: "t-_TS1e-0GzDAX02", name: "Iker", country: "es" }
    ]
  },
  {
    code: "de",
    label: "German",
    flag: "🇩🇪",
    voices: [
      { id: "aBNlTApBeOlVKa23", name: "Lorena", country: "de" },
      { id: "4Mn9VfG2wsLLEzi5", name: "Jette", country: "de" },
      { id: "p6Uutkyi3j2iNAUu", name: "Annika", country: "de" }
    ]
  },
  {
    code: "pt",
    label: "Portuguese",
    flag: "🇵🇹",
    voices: [
      { id: "E8Zwjozrxupd4iQD", name: "Beatriz", country: "br" },
      { id: "KgC2Nqnjj48NUiyV", name: "Manuela-Lu", country: "br" },
      { id: "NuUr_x5V90hSHzCJ", name: "Davi", country: "br" }
    ]
  }
];

/** "us" → 🇺🇸 via Unicode regional indicators. */
function countryFlag(country: string): string {
  return country
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Append a translated segment, adding a space only at word boundaries. */
function appendSegment(current: string, next: string): string {
  if (!current) return next.trimStart();
  if (/\s$/.test(current) || /^[\s.,!?;:]/.test(next)) return current + next;
  return `${current} ${next}`;
}

function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToFloat32(value: string): Float32Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;
  return float32;
}

export function TranslateTab() {
  const sessionId = useRef(getSessionId()).current;
  const [target, setTarget] = useState(LANGUAGES[0].code);
  const [voiceId, setVoiceId] = useState(LANGUAGES[0].voices[0].id);
  const [recording, setRecording] = useState(false);
  const [connected, setConnected] = useState(false);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const readyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [translation, setTranslation] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackRef = useRef<AudioContext | null>(null);
  // Output rate reported by the s2s session's ready message.
  const playbackRateRef = useRef(DEFAULT_PLAYBACK_SAMPLE_RATE);
  // Next free moment on the playback clock, so chunks butt up without gaps.
  const cursorRef = useRef(0);

  const agent = useAgent({
    agent: "translate-agent",
    name: sessionId,
    onOpen: () => setConnected(true),
    onClose: () => {
      setConnected(false);
      if (activeRef.current) {
        setError("Connection lost. Reconnect and try again.");
        stop(false);
      }
    },
    onMessage: (event) => {
      if (!activeRef.current || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "translation-ready") {
        readyRef.current = true;
        if (typeof message.sampleRate === "number" && message.sampleRate > 0) {
          playbackRateRef.current = message.sampleRate;
        }
      } else if (
        message.type === "translation-text" &&
        typeof message.text === "string"
      ) {
        const text = message.text;
        setTranslation((current) => appendSegment(current, text));
      } else if (
        message.type === "translation-audio" &&
        typeof message.audio === "string"
      ) {
        try {
          playChunk(message.audio);
        } catch {
          setError("Could not play translated audio. Try again.");
          stop();
        }
      } else if (message.type === "translation-error") {
        setError("Translation failed. Try again.");
        stop(false);
      } else if (message.type === "translation-stopped") {
        stop(false);
      }
    }
  });

  const playChunk = useCallback((base64: string) => {
    let ctx = playbackRef.current;
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: playbackRateRef.current });
      playbackRef.current = ctx;
      cursorRef.current = ctx.currentTime;
    }

    const samples = base64ToFloat32(base64);
    const buffer = ctx.createBuffer(1, samples.length, playbackRateRef.current);
    buffer.copyToChannel(samples, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, cursorRef.current);
    source.start(startAt);
    cursorRef.current = startAt + buffer.duration;
  }, []);

  const stop = useCallback(
    (notify = true) => {
      const wasActive = activeRef.current;
      activeRef.current = false;
      generationRef.current++;
      readyRef.current = false;
      processorRef.current?.disconnect();
      processorRef.current = null;
      void captureRef.current?.close().catch(() => {});
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void playbackRef.current?.close().catch(() => {});
      playbackRef.current = null;
      cursorRef.current = 0;
      setRecording(false);
      if (notify && wasActive && agent.readyState === WebSocket.OPEN) {
        void agent.stub.stopTranslation().catch(() => {});
      }
    },
    [agent]
  );

  const start = useCallback(async () => {
    if (activeRef.current || agent.readyState !== WebSocket.OPEN) return;
    activeRef.current = true;
    const generation = ++generationRef.current;
    setRecording(true);
    setError(null);
    setTranslation("");
    playbackRateRef.current = DEFAULT_PLAYBACK_SAMPLE_RATE;
    try {
      const started = await agent.stub.startTranslation(target, voiceId);
      if (generation !== generationRef.current) return;
      if (!started) {
        stop(false);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      captureRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (!readyRef.current || generation !== generationRef.current) return;
        const samples = event.inputBuffer.getChannelData(0);
        agent.send(
          JSON.stringify({
            type: "audio-chunk",
            data: float32ToInt16Base64(samples)
          })
        );
      };
      source.connect(processor);
      processor.connect(ctx.destination);
    } catch {
      if (generation !== generationRef.current) return;
      setError(
        "Could not start translation. Check microphone access and try again."
      );
      stop();
    }
  }, [agent, stop, target, voiceId]);

  useEffect(() => () => stop(), [stop]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 px-5 py-4">
      <Surface className="flex flex-col gap-4 rounded-xl p-4 ring ring-kumo-line">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-kumo-secondary">
            Translate to
          </span>
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((language) => (
              <Button
                key={language.code}
                variant={language.code === target ? "primary" : "secondary"}
                size="sm"
                disabled={recording}
                onClick={() => {
                  setTarget(language.code);
                  // Voices are per-language; fall back to the language's top pick.
                  setVoiceId(language.voices[0].id);
                }}
              >
                {language.flag} {language.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
            <span className="font-medium uppercase tracking-wide">Voice</span>
            <select
              value={voiceId}
              disabled={recording}
              onChange={(event) => setVoiceId(event.target.value)}
              className="min-w-44 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
              aria-label="Voice"
            >
              {LANGUAGES.find(
                (language) => language.code === target
              )?.voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {countryFlag(voice.country)} {voice.name}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant={recording ? "destructive" : "primary"}
            disabled={!connected}
            onClick={() => (recording ? stop() : void start())}
            icon={
              recording ? (
                <StopCircleIcon size={18} weight="fill" />
              ) : (
                <MicrophoneIcon size={18} weight="fill" />
              )
            }
          >
            {recording ? "Stop" : "Start translating"}
          </Button>

          <Button
            variant="secondary"
            disabled={translation === ""}
            onClick={() => setTranslation("")}
            icon={<TrashIcon size={18} />}
          >
            Clear
          </Button>
        </div>
      </Surface>

      {error && (
        <Surface className="rounded-xl px-4 py-3 text-sm text-kumo-danger ring ring-kumo-danger">
          {error}
        </Surface>
      )}

      <Surface className="min-h-0 flex-1 overflow-y-auto rounded-xl p-4 ring ring-kumo-line">
        {translation === "" ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
            <TranslateIcon size={28} className="text-kumo-inactive" />
            <Text size="sm" variant="secondary">
              Speak in any language. Gradium transcribes, translates, and
              re-synthesizes over one socket — you hear the translation as you
              talk.
            </Text>
          </div>
        ) : (
          <p className="text-base leading-relaxed text-kumo-default">
            {translation}
          </p>
        )}
      </Surface>
    </div>
  );
}
