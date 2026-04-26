import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ActivityIndicator,
  Animated,
  Dimensions,
  Alert,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, AudioModule, RecordingPresets } from "expo-audio";
import { Colors } from "../../../src/constants/colors";
import { useAvatars } from "../../../src/context/AvatarContext";
import * as FileSystem from "expo-file-system/legacy";
import {
  isLatentSyncServerlessConfigured,
  submitLatentSyncJob,
  pollLatentSyncJob,
  warmupLatentSyncWorker,
} from "../../../src/lib/modal-lipsync";
import { transcribeAudio } from "../../../src/lib/openai";
import { textToSpeech, textToSpeechBase64 } from "../../../src/lib/elevenlabs";
import { submitReport } from "../../../src/lib/report";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const AVATAR_PANEL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.48);
const VOICE_SHEET_HEIGHT = 146;
// Bubble: up to 3 lines × 20px lineHeight + 2 × 12px paddingVertical
const VOICE_TRANSCRIPT_BUBBLE_HEIGHT = 84;
// How many px the chat section rises above the avatar panel bottom.
// Approx height of 2 message bubbles, so they float visually over the avatar.
const CHAT_OVERLAP = 96;
// Local phone TTS can be memory-heavy on some devices and cause white-screen
// crashes. Keep disabled by default; enable explicitly if needed.

// Whisper frequently hallucinates these phrases when the input is silent or
// contains only background noise. Discard transcripts that exactly match.
const WHISPER_HALLUCINATIONS = new Set([
  "you",
  "you.",
  "thank you",
  "thank you.",
  "thanks",
  "thanks.",
  "thanks for watching",
  "thanks for watching.",
  "thank you for watching",
  "thank you for watching.",
  "thank you so much",
  "thank you so much.",
  "bye",
  "bye.",
  "okay",
  "okay.",
  "...",
  "…",
]);
const ENABLE_LOCAL_PHONE_TTS =
  (process.env.EXPO_PUBLIC_ENABLE_LOCAL_PHONE_TTS ?? "false")
    .trim()
    .toLowerCase() === "true";

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { avatars, coins, messages, sendMessage, spendCoin, spendCoins } =
    useAvatars();
  const insets = useSafeAreaInsets();

  const avatar = avatars.find((a: { id: string }) => a.id === id);
  const chatMessages = messages[id ?? ""] ?? [];
  const [displayedVideoUrl, setDisplayedVideoUrl] = useState<string | null>(
    avatar?.videoUrl ?? null,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  // 'preparing' = TTS/image fetch, 'queued' = waiting for worker, 'running' = inference, 'downloading' = fetching video
  const [generationPhase, setGenerationPhase] = useState<
    "preparing" | "queued" | "running" | "downloading"
  >("preparing");
  const [queueElapsedSec, setQueueElapsedSec] = useState(0);
  const generationPhaseRef = useRef<
    "preparing" | "queued" | "running" | "downloading"
  >("preparing");
  const queueTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True once the first successful lipsync reply has completed this session.
  // The 90 s cold-start warning is only shown before the first reply.
  const hasWarmRepliedRef = useRef(false);
  const videoPlayer = useVideoPlayer(null);
  const [isResponseVideo, setIsResponseVideo] = useState(false);
  const responseVideoResolverRef = useRef<(() => void) | null>(null);
  // Fades the video panel out→in when swapping response→idle to hide the zoom snap
  const videoFadeAnim = useRef(new Animated.Value(1)).current;
  const responseVideoSafetyTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showNoCoins, setShowNoCoins] = useState(false);
  const [replyStatusText, setReplyStatusText] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(72);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  // ── Voice conversation mode ──
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [voicePhase, setVoicePhase] = useState<
    "listening" | "processing" | "speaking"
  >("listening");
  const [lastVoiceTranscript, setLastVoiceTranscript] = useState("");
  const flatListRef = useRef<FlatList>(null);
  const ttsPlayer = useAudioPlayer(null);
  // Voice mode refs — keep mutable values stable across async iterations
  const isVoiceModeRef = useRef(false);
  const speechDetectedRef = useRef(false);
  const meterEventsSeenRef = useRef(false);
  const isStartingListeningRef = useRef(false);
  const isProcessingRecordingRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const voiceTurnIdRef = useRef(0);
  const lastAudioTimeRef = useRef(0);
  const recordingStartRef = useRef(0);
  const lastRecordingFingerprintRef = useRef<string | null>(null);
  // Stores the last text spoken by the avatar; used to detect mic echo of TTS
  const lastSpokenTextRef = useRef<string>("");
  const audioRecorderRef = useRef<InstanceType<
    typeof AudioModule.AudioRecorder
  > | null>(null);
  const meteringSubRef = useRef<{ remove: () => void } | null>(null);
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const voicePulseAnim = useRef(new Animated.Value(1)).current;
  const voiceSheetAnim = useRef(new Animated.Value(VOICE_SHEET_HEIGHT)).current;
  const inputBarAnim = useRef(new Animated.Value(0)).current; // 0 = visible, 1 = hidden
  const coinsRef = useRef(coins);
  const isPlayingResponseRef = useRef(false);
  const composerInset = insets.bottom + 4;
  const isKeyboardOpen = Platform.OS === "android" && keyboardHeight > 0;
  const composerDockBottom = Math.max(
    0,
    SCREEN_HEIGHT - AVATAR_PANEL_HEIGHT - composerHeight,
  );
  const composerBottom =
    Platform.OS === "android" && isKeyboardOpen
      ? Math.max(keyboardHeight, composerDockBottom)
      : 0;
  const messageListTopPadding = AVATAR_PANEL_HEIGHT + 8;
  const messageListBottomPadding = isVoiceMode
    ? VOICE_SHEET_HEIGHT + 10 + VOICE_TRANSCRIPT_BUBBLE_HEIGHT + 5
    : composerHeight + composerBottom + (isKeyboardOpen ? 16 : 20);
  const avatarPreviewMessages =
    isKeyboardOpen && chatMessages.length > 0 ? chatMessages.slice(-2) : [];
  const visibleChatMessages = chatMessages;

  const disposeVoiceRecorder = useCallback(async () => {
    const recorder = audioRecorderRef.current;
    audioRecorderRef.current = null;
    if (!recorder) return;

    try {
      await recorder.stop();
    } catch {
      /* ok */
    }

    try {
      (recorder as { remove?: () => void }).remove?.();
    } catch {
      /* ok */
    }
  }, []);

  const createVoiceRecorder = useCallback(() => {
    const recorder = new AudioModule.AudioRecorder({});
    audioRecorderRef.current = recorder;
    return recorder;
  }, []);

  useEffect(() => {
    const nextVideoUrl = avatar?.videoUrl ?? null;
    setDisplayedVideoUrl(nextVideoUrl);
  }, [avatar?.videoUrl]);

  useEffect(() => {
    if (!displayedVideoUrl) return;
    videoPlayer.loop = !isResponseVideo;
    videoPlayer.muted = !isResponseVideo;
    videoPlayer.replace(displayedVideoUrl);
    videoPlayer.play();
  }, [displayedVideoUrl, isResponseVideo, videoPlayer]);

  const stopVoicePlayback = useCallback(() => {
    ttsPlayer.pause();
    setIsSpeaking(false);
  }, [ttsPlayer]);

  // (live-avatar / WebRTC removed — using RunPod serverless instead)

  const isVoiceSessionActive = useCallback((sessionId: number) => {
    return isVoiceModeRef.current && voiceSessionIdRef.current === sessionId;
  }, []);

  const resetVoiceUiState = useCallback(() => {
    setIsRecording(false);
    setIsTranscribing(false);
    setIsSpeaking(false);
    setVoicePhase("listening");
    setLastVoiceTranscript("");
  }, []);

  const cleanupVoiceSession = useCallback(async () => {
    stopListeningTimers();
    await disposeVoiceRecorder();
    stopVoicePlayback();
    lastRecordingFingerprintRef.current = null;
    isStartingListeningRef.current = false;
    isProcessingRecordingRef.current = false;
    resetVoiceUiState();
  }, [disposeVoiceRecorder, resetVoiceUiState, stopVoicePlayback]);

  const scrollToLatest = useCallback((animated: boolean) => {
    const runScroll = () => {
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated });
      });
    };

    const idleCallback =
      "requestIdleCallback" in globalThis
        ? (
            globalThis as typeof globalThis & {
              requestIdleCallback: (callback: () => void) => number;
            }
          ).requestIdleCallback(runScroll)
        : null;

    const timeouts = [0, 80, 180, 320].map((delay) =>
      setTimeout(() => {
        if ("requestIdleCallback" in globalThis) {
          (
            globalThis as typeof globalThis & {
              requestIdleCallback: (callback: () => void) => number;
            }
          ).requestIdleCallback(runScroll);
          return;
        }

        runScroll();
      }, delay),
    );

    return () => {
      if (idleCallback !== null && "cancelIdleCallback" in globalThis) {
        (
          globalThis as typeof globalThis & {
            cancelIdleCallback: (handle: number) => void;
          }
        ).cancelIdleCallback(idleCallback);
      }
      timeouts.forEach(clearTimeout);
    };
  }, []);

  const handleFooterLayout = useCallback(() => {
    scrollToLatest(false);
  }, [scrollToLatest]);

  // Avatar pulse animation while thinking
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (isSending) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.72,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [isSending]);

  // Keep coinsRef in sync so async voice loop always reads current value
  useEffect(() => {
    coinsRef.current = coins;
  }, [coins]);

  // Pulse animation for the voice-mode listening ring
  useEffect(() => {
    if (isVoiceMode && voicePhase === "listening") {
      Animated.loop(
        Animated.sequence([
          Animated.timing(voicePulseAnim, {
            toValue: 1.18,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(voicePulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      voicePulseAnim.stopAnimation();
      voicePulseAnim.setValue(1);
    }
  }, [isVoiceMode, voicePhase]);

  // Animate the voice sheet in/out and manage cleanup
  useEffect(() => {
    isVoiceModeRef.current = isVoiceMode;
    if (isVoiceMode) {
      Animated.parallel([
        Animated.spring(voiceSheetAnim, {
          toValue: 0,
          useNativeDriver: true,
          bounciness: 4,
        }),
        Animated.timing(inputBarAnim, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(() => {
        // After sheet is open, scroll so last message sits above the bubble
        flatListRef.current?.scrollToEnd({ animated: true });
      });
    } else {
      Animated.parallel([
        Animated.timing(voiceSheetAnim, {
          toValue: VOICE_SHEET_HEIGHT,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(inputBarAnim, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
      void AudioModule.setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
        interruptionMode: "doNotMix",
      }).catch(() => {});
      voiceSessionIdRef.current += 1;
      voiceTurnIdRef.current += 1;
      void cleanupVoiceSession();
    }
  }, [cleanupVoiceSession, isVoiceMode]);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const showSubscription = Keyboard.addListener(
      "keyboardDidShow",
      (event) => {
        setKeyboardHeight(Math.max(0, event.endCoordinates.height));
        scrollToLatest(true);
      },
    );

    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
      scrollToLatest(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [insets.bottom, scrollToLatest]);

  useEffect(() => {
    return scrollToLatest(false);
  }, [chatMessages.length, composerHeight, isKeyboardOpen, scrollToLatest]);

  useEffect(() => {
    if (isKeyboardOpen) return;

    return scrollToLatest(false);
  }, [
    isKeyboardOpen,
    visibleChatMessages.length,
    messageListBottomPadding,
    scrollToLatest,
  ]);

  // Track when this screen session started so we can show a divider between
  // old Firestore messages and new messages sent in this session.
  const sessionStartedAtRef = useRef(Date.now());

  // Warmup: fires exactly once per screen focus, independent of any other deps.
  // Keeping this separate from the scroll effect below prevents it from re-firing
  // every time composerHeight changes (keyboard open/close, input resize, etc.).
  useFocusEffect(
    useCallback(() => {
      if (isLatentSyncServerlessConfigured()) {
        warmupLatentSyncWorker().catch(() => undefined);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Scroll-to-latest: fires on focus and whenever composerHeight changes.
  useFocusEffect(
    useCallback(() => {
      return scrollToLatest(false);
    }, [composerHeight, scrollToLatest]),
  );

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isSending || !!replyStatusText) return;
    if (coins < 5) {
      setShowNoCoins(true);
      return;
    }
    setInputText("");
    setIsSending(true);
    spendCoins(5);
    try {
      const reply = await sendMessage(id ?? "", text);
      setIsSending(false);
      // Fire-and-forget: generate lip-sync video (or fallback to TTS audio)
      void generateAvatarResponse(reply);
    } catch (err) {
      console.warn("[Chat] sendMessage error:", err);
    } finally {
      setIsSending(false);
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100,
      );
    }
  };

  // ─── Voice conversation loop ───────────────────────────────────────────────

  const SILENCE_THRESHOLD_DB = -40; // dB below = silence
  const MIN_RECORD_MS = 800; // must record at least 800 ms
  const SILENCE_DURATION_MS = 1800; // 1.8 s of silence → end of turn
  const NO_METERING_FALLBACK_MS = 5500; // if metering never arrives, stop after 5.5 s
  const MAX_RECORD_MS = 12000; // hard safety cap per turn
  const TRANSCRIBE_TIMEOUT_MS = 25000; // avoid hanging forever in processing
  const AUDIO_FILE_READY_TIMEOUT_MS = 2500;

  /** Stop all timers/listeners without stopping the recorder itself. */
  const stopListeningTimers = () => {
    meteringSubRef.current?.remove();
    meteringSubRef.current = null;
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
  };

  const startVoiceListening = async (sessionId = voiceSessionIdRef.current) => {
    if (!isVoiceSessionActive(sessionId)) return;
    if (isStartingListeningRef.current || isProcessingRecordingRef.current)
      return;
    const turnId = ++voiceTurnIdRef.current;
    isStartingListeningRef.current = true;
    console.log("[Voice] startVoiceListening called");
    setVoicePhase("listening");
    setIsRecording(true);
    setLastVoiceTranscript("");
    try {
      stopListeningTimers();
      await disposeVoiceRecorder();

      if (!isVoiceSessionActive(sessionId)) return;

      const recorder = createVoiceRecorder();
      console.log("[Voice] calling prepareToRecordAsync");
      await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
      if (
        !isVoiceSessionActive(sessionId) ||
        turnId !== voiceTurnIdRef.current
      ) {
        await disposeVoiceRecorder();
        return;
      }
      console.log("[Voice] calling record()");
      recorder.record();
      console.log("[Voice] recording started");

      recordingStartRef.current = Date.now();
      speechDetectedRef.current = false;
      meterEventsSeenRef.current = false;
      // Init to now — silence countdown doesn't start until MIN_RECORD_MS elapses
      lastAudioTimeRef.current = Date.now();

      // Metering events: if they fire, keep lastAudioTimeRef fresh while user speaks
      const sub = recorder.addListener(
        "recordingStatusUpdate",
        (status: any) => {
          meterEventsSeenRef.current = true;
          const db = status.metering ?? -160;
          if (db > SILENCE_THRESHOLD_DB) {
            speechDetectedRef.current = true;
            lastAudioTimeRef.current = Date.now();
          }
        },
      );
      meteringSubRef.current = sub;

      // setInterval drives end-of-turn detection, with fallbacks for Android metering issues
      silenceIntervalRef.current = setInterval(() => {
        if (
          !isVoiceSessionActive(sessionId) ||
          turnId !== voiceTurnIdRef.current
        ) {
          stopListeningTimers();
          return;
        }
        const recordAge = Date.now() - recordingStartRef.current;
        const silenceAge = Date.now() - lastAudioTimeRef.current;
        console.log(
          `[Voice] tick — recordAge:${recordAge} silenceAge:${silenceAge}`,
        );
        if (recordAge <= MIN_RECORD_MS) return;

        // Normal path: user spoke, then paused long enough
        if (speechDetectedRef.current && silenceAge > SILENCE_DURATION_MS) {
          stopListeningTimers();
          void processVoiceRecording(sessionId, turnId);
          return;
        }

        // Metering broken path: don't cut too early, but don't run forever either
        if (
          !meterEventsSeenRef.current &&
          recordAge > NO_METERING_FALLBACK_MS
        ) {
          stopListeningTimers();
          void processVoiceRecording(sessionId, turnId);
          return;
        }

        // Safety cap
        if (recordAge > MAX_RECORD_MS) {
          stopListeningTimers();
          void processVoiceRecording(sessionId, turnId);
        }
      }, 300);
    } catch (err) {
      console.warn("[Voice] startListening error:", String(err));
      Alert.alert("Mic error", String(err));
      setIsRecording(false);
      setVoicePhase("listening");
      await disposeVoiceRecorder();
    } finally {
      isStartingListeningRef.current = false;
    }
  };

  const processVoiceRecording = async (sessionId: number, turnId: number) => {
    if (!isVoiceSessionActive(sessionId) || turnId !== voiceTurnIdRef.current)
      return;
    if (isProcessingRecordingRef.current) return;
    isProcessingRecordingRef.current = true;
    let shouldRestartListening = false;
    stopListeningTimers(); // belt-and-suspenders cleanup
    if (!isVoiceSessionActive(sessionId) || turnId !== voiceTurnIdRef.current) {
      isProcessingRecordingRef.current = false;
      return;
    }
    const recorder = audioRecorderRef.current;
    if (!recorder) {
      isProcessingRecordingRef.current = false;
      if (isVoiceSessionActive(sessionId)) void startVoiceListening(sessionId);
      return;
    }
    setIsRecording(false);
    setVoicePhase("processing");
    setIsTranscribing(true);
    try {
      await recorder.stop();
      if (!isVoiceSessionActive(sessionId) || turnId !== voiceTurnIdRef.current)
        return;
      // Give the OS time to flush the file to disk (Android needs this)
      await new Promise((r) => setTimeout(r, 400));
      const uri = recorder.uri;
      console.log("[Voice] recorded uri:", uri);
      if (!uri) throw new Error("Recorder returned no URI after stop.");

      // Verify the file actually exists before sending to Whisper
      const startWait = Date.now();
      let fileInfo = await FileSystem.getInfoAsync(uri);
      let fileSize = (fileInfo as { size?: number }).size ?? 0;

      while (
        Date.now() - startWait < AUDIO_FILE_READY_TIMEOUT_MS &&
        (!fileInfo.exists || fileSize === 0)
      ) {
        await new Promise((r) => setTimeout(r, 180));
        fileInfo = await FileSystem.getInfoAsync(uri);
        fileSize = (fileInfo as { size?: number }).size ?? 0;
      }

      console.log("[Voice] file info:", JSON.stringify(fileInfo));
      if (!fileInfo.exists)
        throw new Error("Audio file not found on disk: " + uri);
      if (fileSize === 0)
        throw new Error("Audio file is empty — nothing was recorded.");

      const fileMtime =
        (fileInfo as { modificationTime?: number }).modificationTime ?? 0;
      const recordingFingerprint = `${uri}|${fileSize}|${fileMtime}`;
      console.log("[Voice] recording fingerprint:", recordingFingerprint);
      if (recordingFingerprint === lastRecordingFingerprintRef.current) {
        console.warn(
          "[Voice] stale recording detected; forcing recorder reset",
        );
        setIsTranscribing(false);
        shouldRestartListening = isVoiceSessionActive(sessionId);
        return;
      }
      lastRecordingFingerprintRef.current = recordingFingerprint;

      // Guard: metering was working but the user never crossed the speech
      // threshold → the recording is silence. Skip Whisper entirely; it will
      // only hallucinate random words if we send it.
      if (meterEventsSeenRef.current && !speechDetectedRef.current) {
        console.log(
          "[Voice] no speech detected above threshold – skipping Whisper",
        );
        setIsTranscribing(false);
        shouldRestartListening = isVoiceSessionActive(sessionId);
        return;
      }

      const transcript = await Promise.race<string>([
        transcribeAudio(uri),
        new Promise<string>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Transcription timed out. Please try again.")),
            TRANSCRIBE_TIMEOUT_MS,
          ),
        ),
      ]);
      if (!isVoiceSessionActive(sessionId) || turnId !== voiceTurnIdRef.current)
        return;
      setIsTranscribing(false);
      if (!transcript || !isVoiceSessionActive(sessionId)) {
        // Nothing useful was said — listen again
        shouldRestartListening = isVoiceSessionActive(sessionId);
        return;
      }

      // Hallucination filter: Whisper returns these phrases on silence/noise.
      if (WHISPER_HALLUCINATIONS.has(transcript.toLowerCase().trim())) {
        console.log(
          "[Voice] discarding Whisper hallucination:",
          JSON.stringify(transcript),
        );
        shouldRestartListening = isVoiceSessionActive(sessionId);
        return;
      }

      // Echo guard: reject transcripts that closely match the last thing the
      // avatar said. This catches the mic picking up TTS speaker audio.
      if (lastSpokenTextRef.current) {
        const t = transcript.toLowerCase().trim();
        const s = lastSpokenTextRef.current.toLowerCase().trim();
        const prefix = s.slice(0, Math.min(35, s.length));
        if (prefix.length >= 15 && t.includes(prefix)) {
          console.warn(
            "[Voice] echo guard: transcript matches last spoken reply – discarding",
          );
          shouldRestartListening = isVoiceSessionActive(sessionId);
          return;
        }
      }

      setLastVoiceTranscript(transcript);

      if (coinsRef.current < 5) {
        setShowNoCoins(true);
        setIsVoiceMode(false);
        return;
      }
      spendCoins(5);
      setIsSending(true);
      const reply = await sendMessage(id ?? "", transcript);
      setIsSending(false);
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100,
      );

      if (!isVoiceSessionActive(sessionId)) return;
      setVoicePhase("speaking");
      // Await full generation + playback so mic doesn't reopen during response
      await generateAvatarResponse(reply);
      if (!isVoiceSessionActive(sessionId) || turnId !== voiceTurnIdRef.current)
        return;

      // Continue the conversation loop
      shouldRestartListening = isVoiceSessionActive(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Voice] processRecording error:", msg);
      setIsTranscribing(false);
      setIsSending(false);
      // Show error so user can report the exact message
      Alert.alert("Voice error", msg, [
        {
          text: "Retry",
          onPress: () => {
            if (isVoiceModeRef.current) void startVoiceListening();
          },
        },
        {
          text: "End voice",
          style: "destructive",
          onPress: stopVoiceMode,
        },
      ]);
    } finally {
      if (audioRecorderRef.current === recorder) {
        audioRecorderRef.current = null;
      }
      try {
        (recorder as { remove?: () => void }).remove?.();
      } catch {
        /* ok */
      }
      isProcessingRecordingRef.current = false;
      if (shouldRestartListening && isVoiceSessionActive(sessionId)) {
        // Wait for speaker audio to fully dissipate before reopening the mic.
        // Without this delay the mic picks up the tail of the TTS playback and
        // sends it back as a new user message, creating a voice feedback loop.
        await new Promise((r) => setTimeout(r, 900));
        if (isVoiceSessionActive(sessionId)) {
          void startVoiceListening(sessionId);
        }
      }
    }
  };

  const stopVoiceMode = useCallback(() => {
    voiceSessionIdRef.current += 1;
    setIsVoiceMode(false);
  }, []);

  const handleReportMessage = (text: string) => {
    Alert.alert("Report message", "Report this AI-generated message as harmful or inappropriate?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Report",
        style: "destructive",
        onPress: async () => {
          try {
            await submitReport({ type: "chat_message", content: text, avatarId: id ?? undefined });
            Alert.alert("Reported", "Thank you. We'll review this message.");
          } catch {
            Alert.alert("Error", "Could not submit report. Please try again.");
          }
        },
      },
    ]);
  };

  const startVoiceSession = useCallback(async () => {
    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) {
      Alert.alert(
        "Microphone permission needed",
        "Please allow microphone access to use voice conversation.",
      );
      return;
    }

    await AudioModule.setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: "doNotMix",
    });

    lastRecordingFingerprintRef.current = null;
    const sessionId = ++voiceSessionIdRef.current;
    voiceTurnIdRef.current += 1;
    setIsVoiceMode(true);
    isVoiceModeRef.current = true;
    void startVoiceListening(sessionId);
  }, [startVoiceListening]);

  const toggleVoiceMode = async () => {
    if (isVoiceMode) {
      stopVoiceMode();
      return;
    }
    await startVoiceSession();
  };

  // ─── Speak a reply ─────────────────────────────────────────────────────────

  /** Returns a Promise that resolves when TTS playback finishes (or fails). */
  const speakReplyAndWait = (text: string): Promise<void> => {
    if (!ENABLE_LOCAL_PHONE_TTS) {
      return Promise.resolve();
    }

    lastSpokenTextRef.current = text;
    return new Promise((resolve) => {
      setIsSpeaking(true);
      textToSpeech(text)
        .then((fileUri) => {
          ttsPlayer.replace({ uri: fileUri });
          ttsPlayer.play();
          const sub = ttsPlayer.addListener(
            "playbackStatusUpdate",
            (status) => {
              if (status.didJustFinish) {
                setIsSpeaking(false);
                sub.remove();
                resolve();
              }
            },
          );
        })
        .catch((err) => {
          console.warn("[TTS] error:", err);
          setIsSpeaking(false);
          resolve();
        });
    });
  };

  /** Fire-and-forget version used when sending a text message. */
  const speakReply = (text: string) => {
    void speakReplyAndWait(text);
  };

  // ─── Serverless avatar response ────────────────────────────────────────────

  /**
   * Plays a response video once, then restores the idle loop.
   * Resolves when playback is complete (or times out after 90 s).
   */
  const waitForResponseVideoPlayback = useCallback(
    (videoUrl: string): Promise<void> => {
      return new Promise<void>((resolve) => {
        isPlayingResponseRef.current = true;
        videoFadeAnim.setValue(0); // hidden until readyToPlay — static image shows while buffering
        setIsResponseVideo(true);
        setDisplayedVideoUrl(videoUrl);

        let hasStartedPlaying = false;
        let resolved = false;

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          sub.remove();
          isPlayingResponseRef.current = false;
          // Fade out, swap to idle, fade back in — hides the aspect-ratio snap
          Animated.timing(videoFadeAnim, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
          }).start(() => {
            setIsResponseVideo(false);
            const idleUrl = avatar?.videoUrl ?? null;
            setDisplayedVideoUrl(idleUrl);
            Animated.timing(videoFadeAnim, {
              toValue: 1,
              duration: 250,
              useNativeDriver: true,
            }).start();
            resolve();
          });
        };

        responseVideoResolverRef.current = resolveOnce;

        const sub = videoPlayer.addListener("statusChange", (event: any) => {
          const status = event.status as string;
          if (status === "readyToPlay") {
            hasStartedPlaying = true;
            // Fade in now that the first frame is ready — no black flash
            Animated.timing(videoFadeAnim, {
              toValue: 1,
              duration: 180,
              useNativeDriver: true,
            }).start();
            return;
          }
          if (
            status === "idle" &&
            hasStartedPlaying &&
            isPlayingResponseRef.current
          ) {
            resolveOnce();
          }
        });

        // Safety: always resolve after 90 s
        if (responseVideoSafetyTimerRef.current) {
          clearTimeout(responseVideoSafetyTimerRef.current);
        }
        responseVideoSafetyTimerRef.current = setTimeout(() => {
          resolveOnce();
          responseVideoResolverRef.current = null;
          responseVideoSafetyTimerRef.current = null;
        }, 90_000);
      });
    },
    [avatar?.videoUrl, videoPlayer],
  );

  /**
   * Full serverless pipeline:
   *   ElevenLabs TTS → RunPod LatentSync job → response video (audio muxed in).
   * Falls back to local audio-only TTS when the endpoint is not configured.
   * Returns a Promise that resolves after playback finishes (voice loop waits).
   */
  const generateAvatarResponse = useCallback(
    async (text: string): Promise<void> => {
      if (!isLatentSyncServerlessConfigured() || !avatar) {
        await speakReplyAndWait(text);
        return;
      }

      setIsGenerating(true);
      setGenerationProgress(0);
      setGenerationPhase("preparing");
      generationPhaseRef.current = "preparing";

      const stopQueueTimer = () => {
        if (queueTimerRef.current) {
          clearInterval(queueTimerRef.current);
          queueTimerRef.current = null;
        }
      };

      try {
        // 1. ElevenLabs TTS → base64 audio
        setGenerationProgress(5);
        const audioBase64 = await textToSpeechBase64(
          text,
          avatar.voiceId ?? undefined,
        );

        // 2. Resolve source image
        setGenerationProgress(15);
        let sourceImageUrl: string | undefined;
        let sourceImageBase64: string | undefined;
        let sourceImageMimeType: string | undefined;
        if (/^https?:\/\//i.test(avatar.imageUri)) {
          sourceImageUrl = avatar.imageUri;
        } else {
          sourceImageBase64 = await FileSystem.readAsStringAsync(
            avatar.imageUri,
            { encoding: FileSystem.EncodingType.Base64 },
          );
          sourceImageMimeType = avatar.imageUri.toLowerCase().endsWith(".png")
            ? "image/png"
            : "image/jpeg";
        }

        // 3. Submit RunPod job — enter 'queued' phase, start elapsed timer
        setGenerationProgress(20);
        const { id: jobId } = await submitLatentSyncJob({
          sourceImageUrl,
          sourceImageBase64,
          sourceImageMimeType,
          audioBase64,
        });
        setGenerationPhase("queued");
        generationPhaseRef.current = "queued";
        setQueueElapsedSec(0);
        const queueStart = Date.now();
        queueTimerRef.current = setInterval(() => {
          setQueueElapsedSec(Math.round((Date.now() - queueStart) / 1000));
        }, 1000);

        // 4. Poll until complete — switch to 'running' when IN_PROGRESS
        const videoUrl = await pollLatentSyncJob(
          jobId,
          (pct) => {
            if (pct >= 10 && generationPhaseRef.current !== "running") {
              setGenerationPhase("running");
              generationPhaseRef.current = "running";
              stopQueueTimer();
            }
            setGenerationProgress(20 + Math.round(pct * 0.75));
          },
          { expectedGenerationMs: 20_000 },
        );

        stopQueueTimer();
        setGenerationProgress(100);
        hasWarmRepliedRef.current = true;

        // 5. Play response video; await for voice loop sync
        setIsGenerating(false);

        // 6. Play response video; await for voice loop sync
        await waitForResponseVideoPlayback(videoUrl);
      } catch (err) {
        console.warn("[LatentSync] generation failed:", err);
        stopQueueTimer();
        setIsGenerating(false);
        setGenerationProgress(0);
        await speakReplyAndWait(text);
      }

      setIsGenerating(false);
      setGenerationProgress(0);
    },
    [avatar, speakReplyAndWait, waitForResponseVideoPlayback],
  );

  if (!avatar) {
    return (
      <SafeAreaView style={styles.root} edges={["top"]}>
        <View style={styles.notFound}>
          <Text style={styles.notFoundText}>Avatar not found</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
          >
            <Text style={styles.backBtnText}>← Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* ── LAYER 1 (behind): Avatar panel ── absolute, always visible */}
      <Animated.View style={[styles.avatarPanel]}>
        {/* Static avatar always rendered as background */}
        <Image
          source={{ uri: avatar.imageUri }}
          style={styles.avatarPanelImage}
        />
        {displayedVideoUrl ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, { opacity: videoFadeAnim }]}
          >
            <VideoView
              player={videoPlayer}
              style={styles.avatarPanelImage}
              contentFit="cover"
              nativeControls={false}
            />
          </Animated.View>
        ) : null}
        <View style={styles.avatarPanelOverlay} />
        {/* Loading overlay rendered on top when generating — video buffers underneath */}
        {isGenerating ? (
          <>
            <Image
              source={{ uri: avatar.imageUri }}
              style={[
                styles.avatarPanelImage,
                styles.avatarPanelBlurred,
                StyleSheet.absoluteFill,
              ]}
              blurRadius={18}
            />
            <View style={styles.generatingOverlay}>
              {generationPhase === "queued" && !hasWarmRepliedRef.current ? (
                <Text style={styles.generatingWarmupLabel}>
                  First reply may take up to 90 sec.{"\n"}Please wait ☕
                </Text>
              ) : null}
              <ActivityIndicator color={Colors.white} size={56} />
              {generationPhase === "running" ? (
                <Text style={styles.generatingPercent}>
                  {generationProgress}%
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
        {/* Header overlaid on avatar */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <View style={styles.backButtonBg}>
              <Ionicons name="chevron-back" size={22} color={Colors.white} />
            </View>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={styles.coinBadge}
            onPress={() => router.push("/buy-coins")}
          >
            <Text style={styles.coinEmoji}>🪙</Text>
            <Text style={[styles.coinCount, coins <= 2 && styles.coinCountLow]}>
              {coins}
            </Text>
            {coins <= 2 && <Text style={styles.buyMore}>+ Buy</Text>}
          </TouchableOpacity>
        </View>
        {/* Name + status at bottom-left of avatar */}
        <View style={styles.avatarMeta}>
          <Text style={styles.avatarPanelName}>{avatar.name}</Text>
          {isSending ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator color={Colors.white} size="small" />
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          ) : replyStatusText ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator color={Colors.white} size="small" />
              <Text style={styles.thinkingText}>{replyStatusText}</Text>
            </View>
          ) : (
            <View style={styles.onlineRow}>
              <View style={styles.onlineDot} />
              <Text style={styles.onlineText}>Online</Text>
            </View>
          )}
        </View>
        {avatarPreviewMessages.length > 0 && (
          <View style={styles.avatarMessagesOverlay} pointerEvents="none">
            {avatarPreviewMessages.map((message, index) => (
              <View
                key={`${message.role}-${index}-${message.text.slice(0, 24)}`}
                style={[
                  styles.avatarMessageLine,
                  message.role === "user"
                    ? styles.avatarMessageLineUser
                    : styles.avatarMessageLineBot,
                ]}
              >
                <Text
                  style={[
                    styles.avatarMessageText,
                    message.role === "user"
                      ? styles.avatarMessageTextUser
                      : styles.avatarMessageTextBot,
                  ]}
                  numberOfLines={3}
                >
                  {message.text}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Animated.View>

      {/* ── LAYER 2: Scrollable chat behind avatar ── */}
      <KeyboardAvoidingView
        style={styles.chatSection}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.chatSolidBg} />

        <FlatList
          ref={flatListRef}
          data={visibleChatMessages}
          keyExtractor={(_, i) => i.toString()}
          contentContainerStyle={styles.messageList}
          style={styles.flatList}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: false })
          }
          ListHeaderComponent={
            <View style={{ height: messageListTopPadding }} />
          }
          ListFooterComponent={
            <View
              style={{ height: messageListBottomPadding }}
              onLayout={handleFooterLayout}
            />
          }
          renderItem={({ item, index }) => {
            // Show a "New conversation" divider before the first message
            // that was sent in this app session.
            const isFirstNewMessage =
              typeof item.createdAt === "number" &&
              item.createdAt >= sessionStartedAtRef.current &&
              (index === 0 ||
                (visibleChatMessages[index - 1]?.createdAt ?? 0) <
                  sessionStartedAtRef.current);
            return (
              <>
                {isFirstNewMessage && index > 0 && (
                  <View style={styles.sessionDivider}>
                    <View style={styles.sessionDividerLine} />
                    <Text style={styles.sessionDividerText}>
                      New conversation
                    </Text>
                    <View style={styles.sessionDividerLine} />
                  </View>
                )}
                <TouchableOpacity
                  activeOpacity={item.role === "user" ? 1 : 0.85}
                  onLongPress={
                    item.role !== "user"
                      ? () => handleReportMessage(item.text)
                      : undefined
                  }
                  delayLongPress={400}
                  style={[
                    styles.bubble,
                    item.role === "user" ? styles.bubbleUser : styles.bubbleBot,
                  ]}
                >
                  {item.role === "avatar" && (
                    <Image
                      source={{ uri: avatar.imageUri }}
                      style={styles.bubbleAvatar}
                    />
                  )}
                  <View
                    style={[
                      styles.bubbleText,
                      item.role === "user"
                        ? styles.bubbleTextUser
                        : styles.bubbleTextBot,
                    ]}
                  >
                    <Text
                      style={[
                        styles.bubbleMsg,
                        item.role === "user" && styles.bubbleMsgUser,
                      ]}
                    >
                      {item.text}
                    </Text>
                  </View>
                </TouchableOpacity>
              </>
            );
          }}
          ListEmptyComponent={
            chatMessages.length === 0 ? (
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatEmoji}>👋</Text>
                <Text style={styles.emptyChatText}>
                  Say hello to {avatar.name}!
                </Text>
              </View>
            ) : null
          }
        />
      </KeyboardAvoidingView>

      {/* ── LAYER 3: Input bar ── hidden while voice mode is active ── */}
      <Animated.View
        style={[
          styles.inputBarWrap,
          {
            bottom: composerBottom,
            transform: [
              {
                translateY: inputBarAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 160],
                }),
              },
            ],
            opacity: inputBarAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0],
            }),
          },
        ]}
        pointerEvents={isVoiceMode ? "none" : "auto"}
      >
        <View
          style={[styles.inputBar, { paddingBottom: composerInset }]}
          onLayout={(event) => {
            const nextHeight = Math.ceil(event.nativeEvent.layout.height);
            if (nextHeight > 0 && nextHeight !== composerHeight) {
              setComposerHeight(nextHeight);
            }
          }}
        >
          {/* Voice-mode toggle on the left */}
          <TouchableOpacity
            style={[
              styles.voiceToggleButton,
              isVoiceMode && styles.voiceToggleButtonActive,
            ]}
            onPress={toggleVoiceMode}
            activeOpacity={0.75}
          >
            <Ionicons
              name={isVoiceMode ? "mic" : "mic-outline"}
              size={22}
              color={isVoiceMode ? "#FF6B6B" : Colors.textSecondary}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            placeholder={`Message ${avatar.name}...`}
            placeholderTextColor={Colors.textMuted}
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={500}
            onSubmitEditing={handleSend}
            onFocus={() => scrollToLatest(true)}
          />
          {inputText.trim() ? (
            <TouchableOpacity
              style={styles.sendButton}
              onPress={handleSend}
              disabled={isSending || !!replyStatusText}
              activeOpacity={0.8}
            >
              {isSending || !!replyStatusText ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Ionicons
                  name="send"
                  size={20}
                  color={Colors.white}
                  style={{ marginLeft: 2 }}
                />
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </Animated.View>

      {/* Transcript bubble - floats just above the voice sheet */}
      {isVoiceMode && (
        <Animated.View
          style={[
            styles.voiceTranscriptBubble,
            { transform: [{ translateY: voiceSheetAnim }] },
          ]}
          pointerEvents="none"
        >
          <Text style={styles.voiceTranscriptBubbleText} numberOfLines={3}>
            {lastVoiceTranscript
              ? `"${lastVoiceTranscript}"`
              : voicePhase === "listening"
                ? "Speak — I’m listening…"
                : voicePhase === "processing"
                  ? "Got it, thinking…"
                  : `${avatar.name} is responding…`}
          </Text>
        </Animated.View>
      )}

      {/* ── Voice bottom sheet (slides up, chat stays visible above) ── */}
      <Animated.View
        style={[
          styles.voiceSheet,
          {
            transform: [{ translateY: voiceSheetAnim }],
            paddingBottom: insets.bottom + 8,
          },
        ]}
        pointerEvents={isVoiceMode ? "auto" : "none"}
      >
        {/* Drag handle */}
        <View style={styles.voiceSheetHandle} />

        {/* Compact row: mic • status text • spacer • close */}
        <View style={styles.voiceSheetContent}>
          <View style={styles.voiceMicWrapper}>
            <Animated.View
              style={[
                styles.voicePulseRing,
                {
                  transform: [{ scale: voicePulseAnim }],
                  opacity: voicePhase === "listening" ? 0.35 : 0,
                },
              ]}
            />
            <View style={styles.voiceMicCircle}>
              {voicePhase === "processing" ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : voicePhase === "speaking" ? (
                <Ionicons name="volume-high" size={22} color="#66D9A0" />
              ) : (
                <Ionicons name="mic" size={22} color="#FF6B6B" />
              )}
            </View>
          </View>

          <Text style={styles.voiceStatusText}>
            {voicePhase === "listening"
              ? "Listening…"
              : voicePhase === "processing"
                ? "Thinking…"
                : `${avatar.name} is speaking…`}
          </Text>

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            style={styles.voiceEndBtn}
            onPress={stopVoiceMode}
            activeOpacity={0.8}
          >
            <Ionicons name="close" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* No coins overlay */}
      {showNoCoins && (
        <View style={styles.noCoinsOverlay}>
          <View style={styles.noCoinsCard}>
            <Text style={styles.noCoinsEmoji}>🪙</Text>
            <Text style={styles.noCoinsTitle}>Out of coins!</Text>
            <Text style={styles.noCoinsText}>
              Get more coins to keep chatting
            </Text>
            <TouchableOpacity
              style={styles.buyButton}
              onPress={() => {
                setShowNoCoins(false);
                router.push("/buy-coins");
              }}
            >
              <Text style={styles.buyButtonText}>Get Free Coins</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowNoCoins(false)}>
              <Text style={styles.dismissText}>Maybe later</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },

  // ── Avatar panel (absolute, behind chat) ──
  avatarPanel: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: AVATAR_PANEL_HEIGHT,
    backgroundColor: Colors.surface,
    overflow: "hidden",
    zIndex: 3,
  },
  avatarPanelLiveAndroid: {
    overflow: "visible",
    backgroundColor: "#000",
  },
  avatarPanelImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  avatarPanelBlurred: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
    opacity: 0.55,
  },
  generatingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  generatingWarmupLabel: {
    color: Colors.white,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 12,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  generatingPercent: {
    color: Colors.white,
    fontSize: 25,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  generatingLabel: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 15,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  generatingPhaseLabel: {
    color: Colors.white,
    fontSize: 18,
    fontWeight: "700",
  },
  generatingElapsed: {
    color: Colors.white,
    fontSize: 18,
    fontWeight: "700",
  },
  generatingHint: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontWeight: "500",
  },
  avatarPanelRtcView: {
    backgroundColor: "#000",
  },
  avatarPanelOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13,13,26,0.0)",
  },
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    zIndex: 3,
  },
  backButton: { padding: 4 },
  backButtonBg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  coinBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  coinEmoji: { fontSize: 14 },
  coinCount: { color: Colors.gold, fontWeight: "700", fontSize: 14 },
  coinCountLow: { color: Colors.error },
  buyMore: { color: "#a78bfa", fontSize: 11, fontWeight: "700", marginLeft: 2 },
  animateBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    minWidth: 44,
    justifyContent: "center",
  },
  animateBtnBusy: {
    opacity: 0.7,
  },
  featureBtnDisabled: {
    opacity: 0.45,
  },
  animateBtnText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "700",
  },
  liveBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    minWidth: 58,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
  },
  liveBtnActive: {
    backgroundColor: "rgba(255,59,48,0.24)",
    borderColor: "rgba(255,59,48,0.5)",
  },
  liveBtnText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "800",
  },
  avatarMeta: {
    position: "absolute",
    bottom: 14,
    left: 16,
    gap: 4,
    zIndex: 3,
  },
  avatarMessagesOverlay: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 84,
    gap: 8,
    zIndex: 3,
  },
  avatarMessageLine: {
    maxWidth: "82%",
  },
  avatarMessageLineUser: {
    alignSelf: "flex-end",
  },
  avatarMessageLineBot: {
    alignSelf: "flex-start",
  },
  avatarMessageText: {
    fontSize: 16,
    lineHeight: 21,
    textShadowColor: "rgba(0,0,0,0.65)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  avatarMessageTextUser: {
    color: Colors.white,
    fontWeight: "700",
    textAlign: "right",
  },
  avatarMessageTextBot: {
    color: "#4ade80",
    fontWeight: "600",
    textAlign: "left",
  },
  avatarPanelName: {
    color: Colors.white,
    fontSize: 22,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  liveStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
  },
  liveDotConnecting: {
    backgroundColor: "#f59e0b",
  },
  liveStatusText: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 13,
    fontWeight: "700",
  },
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  thinkingText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontStyle: "italic",
  },
  onlineRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#22c55e",
  },
  onlineText: { color: "rgba(255,255,255,0.75)", fontSize: 13 },

  // ── Transparent spacer ──
  avatarSpacer: {
    height: 0,
    backgroundColor: "transparent",
  },

  // ── Chat section ──
  chatSection: {
    flex: 1,
    zIndex: 1,
    position: "relative",
    backgroundColor: "transparent",
  },
  chatSolidBg: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.background,
  },
  flatList: {
    flex: 1,
    backgroundColor: "transparent",
  },
  messageList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 10,
  },
  bubble: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  bubbleUser: { justifyContent: "flex-end" },
  bubbleBot: { justifyContent: "flex-start" },
  bubbleAvatar: { width: 28, height: 28, borderRadius: 14 },
  bubbleText: {
    maxWidth: "78%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
  },
  bubbleTextUser: {
    backgroundColor: Colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleTextBot: {
    backgroundColor: Colors.surface,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  bubbleMsg: { color: Colors.text, fontSize: 15, lineHeight: 20 },
  bubbleMsgUser: { color: Colors.white },
  sessionDivider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 16,
    marginHorizontal: 16,
    gap: 8,
  },
  sessionDividerLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  sessionDividerText: { color: Colors.textSecondary, fontSize: 12 },
  emptyChat: { alignItems: "center", paddingTop: 24, gap: 8 },
  emptyChatEmoji: { fontSize: 36 },
  emptyChatText: { color: Colors.textSecondary, fontSize: 15 },

  // ── Input bar ──
  inputBarWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 8,
    backgroundColor: Colors.background,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    paddingTop: 12,
    color: Colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: Colors.border,
    maxHeight: 100,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Voice toggle button (left of input) ──
  voiceToggleButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  voiceToggleButtonActive: {
    backgroundColor: "rgba(255,107,107,0.18)",
    borderColor: "#FF6B6B",
  },

  // ── Voice bottom sheet ──
  voiceTranscriptBubble: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: VOICE_SHEET_HEIGHT + 10,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    zIndex: 9,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 8,
  },
  voiceTranscriptBubbleText: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 20,
    fontStyle: "italic",
  },
  voiceSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: VOICE_SHEET_HEIGHT,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    zIndex: 10,
    alignItems: "center",
    paddingTop: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 18,
  },
  voiceSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginBottom: 14,
  },
  voiceSheetContent: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    gap: 14,
  },
  voiceSheetInfo: {
    flex: 1,
    gap: 4,
  },
  voiceMicWrapper: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  voicePulseRing: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,107,107,0.28)",
  },
  voiceMicCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "rgba(255,107,107,0.12)",
    borderWidth: 2,
    borderColor: "rgba(255,107,107,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  voiceStatusText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  voiceTranscript: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontStyle: "italic",
    lineHeight: 18,
  },
  voiceHint: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  voiceEndBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,59,48,0.15)",
    borderWidth: 1,
    borderColor: "rgba(255,59,48,0.4)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  // ── No coins overlay ──
  noCoinsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  noCoinsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 24,
    padding: 32,
    alignItems: "center",
    gap: 10,
    width: "80%",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noCoinsEmoji: { fontSize: 48 },
  noCoinsTitle: { color: Colors.text, fontSize: 22, fontWeight: "800" },
  noCoinsText: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
  },
  buyButton: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 36,
    marginTop: 8,
  },
  buyButtonText: { color: Colors.white, fontWeight: "700", fontSize: 16 },
  dismissText: { color: Colors.textMuted, fontSize: 13, marginTop: 4 },

  // ── Not found ──
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  notFoundText: { color: Colors.text, fontSize: 18 },
  backBtn: { padding: 12 },
  backBtnText: { color: Colors.primary, fontSize: 16 },
});
