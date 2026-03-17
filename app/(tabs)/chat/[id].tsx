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
import {
  MediaStream,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from "react-native-webrtc";
import { Colors } from "../../../src/constants/colors";
import { useAvatars } from "../../../src/context/AvatarContext";
import * as FileSystem from "expo-file-system/legacy";
import {
  createAgentFromPhoto,
  createAgentStream,
  createAgentVideoStream,
  createTalk,
  createTalkFromAudio,
  deleteAgentStream,
  pollTalk,
  startAgentConnection,
  submitAgentIceCandidate,
  uploadAudioToDID,
  uploadImageToDID,
} from "../../../src/lib/did";
import {
  createLiveAvatarSession,
  deleteLiveAvatarSession,
  isLiveAvatarBackendConfigured,
  speakLiveAvatarText,
  submitLiveAvatarAnswer,
  submitLiveAvatarIceCandidate,
} from "../../../src/lib/live-avatar";
import { transcribeAudio } from "../../../src/lib/openai";
import { textToSpeech } from "../../../src/lib/elevenlabs";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const AVATAR_PANEL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.48);
const VOICE_SHEET_HEIGHT = 146;
// Bubble: up to 3 lines × 20px lineHeight + 2 × 12px paddingVertical
const VOICE_TRANSCRIPT_BUBBLE_HEIGHT = 84;
// How many px the chat section rises above the avatar panel bottom.
// Approx height of 2 message bubbles, so they float visually over the avatar.
const CHAT_OVERLAP = 96;

type ActiveLiveSession =
  | {
      provider: "did";
      agentId: string;
      streamId: string;
      sessionId: string;
    }
  | {
      provider: "backend";
      sessionId: string;
    };

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const {
    avatars,
    coins,
    messages,
    sendMessage,
    spendCoin,
    updateAvatarVideoUrl,
  } = useAvatars();
  const insets = useSafeAreaInsets();

  const avatar = avatars.find((a: { id: string }) => a.id === id);
  const chatMessages = messages[id ?? ""] ?? [];
  const liveBackendConfigured = isLiveAvatarBackendConfigured();
  const [displayedVideoUrl, setDisplayedVideoUrl] = useState<string | null>(
    avatar?.videoUrl ?? null,
  );
  const [liveRemoteStream, setLiveRemoteStream] = useState<MediaStream | null>(
    null,
  );
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isLiveConnecting, setIsLiveConnecting] = useState(false);
  const [liveStatusText, setLiveStatusText] = useState("Offline");
  const [didPlaybackUnavailable, setDidPlaybackUnavailable] = useState(false);

  const videoPlayer = useVideoPlayer(null, (player) => {
    player.loop = true;
    player.muted = true;
    player.play();
  });

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showNoCoins, setShowNoCoins] = useState(false);
  const [replyStatusText, setReplyStatusText] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(72);
  const [isAnimating, setIsAnimating] = useState(false);
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
  const didSourceUrlRef = useRef<string | null>(null);
  const isAvatarReplyPlaybackRef = useRef(false);
  const didPlaybackUnavailableRef = useRef(false);
  const didCreditsAlertShownRef = useRef(false);
  const livePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const liveSessionRef = useRef<ActiveLiveSession | null>(null);
  const liveAgentIdRef = useRef<string | null>(
    (process.env.EXPO_PUBLIC_DID_AGENT_ID ?? "").trim() || null,
  );
  const pendingIceCandidatesRef = useRef<
    Array<{
      candidate: string | null;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }>
  >([]);
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

  useEffect(() => {
    didPlaybackUnavailableRef.current = didPlaybackUnavailable;
  }, [didPlaybackUnavailable]);

  const isDidCreditsError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("InsufficientCreditsError") ||
      message.includes("not enough credits")
    );
  }, []);

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
    if (isAvatarReplyPlaybackRef.current) return;
    const nextVideoUrl = avatar?.videoUrl ?? null;
    setDisplayedVideoUrl(nextVideoUrl);
    if (!nextVideoUrl) return;
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.replace(nextVideoUrl);
    videoPlayer.play();
  }, [avatar?.videoUrl, videoPlayer]);

  const stopVoicePlayback = useCallback(() => {
    ttsPlayer.pause();
    setIsSpeaking(false);
  }, [ttsPlayer]);

  const playAvatarReplyVideo = useCallback(
    (videoUrl: string) => {
      return new Promise<void>((resolve) => {
        isAvatarReplyPlaybackRef.current = true;
        setDisplayedVideoUrl(videoUrl);
        videoPlayer.loop = false;
        videoPlayer.muted = false;
        videoPlayer.replace(videoUrl);
        videoPlayer.play();

        const sub = videoPlayer.addListener("playToEnd", () => {
          sub.remove();
          videoPlayer.muted = true;
          videoPlayer.loop = true;
          videoPlayer.currentTime = 0;
          videoPlayer.play();
          isAvatarReplyPlaybackRef.current = false;
          resolve();
        });
      });
    },
    [videoPlayer],
  );

  const getDidSourceUrl = useCallback(async () => {
    if (didSourceUrlRef.current) return didSourceUrlRef.current;
    if (!avatar?.imageUri) throw new Error("Avatar image is missing.");

    let uploadUri = avatar.imageUri;
    if (/^https?:\/\//i.test(uploadUri)) {
      const tempUri = `${FileSystem.cacheDirectory ?? ""}${avatar.id}-did-source.jpg`;
      await FileSystem.downloadAsync(uploadUri, tempUri);
      uploadUri = tempUri;
    }

    const didUrl = await uploadImageToDID(uploadUri);
    didSourceUrlRef.current = didUrl;
    return didUrl;
  }, [avatar?.id, avatar?.imageUri]);

  const getLiveAvatarSourceInput = useCallback(async () => {
    if (!avatar?.imageUri) {
      throw new Error("Avatar image is missing.");
    }

    if (/^https?:\/\//i.test(avatar.imageUri)) {
      return { sourceImageUrl: avatar.imageUri };
    }

    const sourceImageBase64 = await FileSystem.readAsStringAsync(
      avatar.imageUri,
      {
        encoding: FileSystem.EncodingType.Base64,
      },
    );

    return {
      sourceImageBase64,
      sourceImageMimeType: avatar.imageUri.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg",
    };
  }, [avatar?.imageUri]);

  const disconnectLiveStream = useCallback(async () => {
    const currentSession = liveSessionRef.current;
    liveSessionRef.current = null;
    pendingIceCandidatesRef.current = [];

    const peerConnection = livePeerConnectionRef.current;
    livePeerConnectionRef.current = null;

    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.close();
    }

    setLiveRemoteStream(null);
    setIsLiveMode(false);
    setIsLiveConnecting(false);
    setLiveStatusText("Offline");

    if (!currentSession) return;

    try {
      if (currentSession.provider === "backend") {
        await deleteLiveAvatarSession({
          sessionId: currentSession.sessionId,
        });
      } else {
        await deleteAgentStream(currentSession);
      }
    } catch (err) {
      console.warn("[D-ID] delete live stream error:", err);
    }
  }, []);

  const submitCurrentLiveIceCandidate = useCallback(
    async (
      session: ActiveLiveSession,
      payload: {
        candidate: string | null;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
      },
    ) => {
      if (session.provider === "backend") {
        await submitLiveAvatarIceCandidate({
          sessionId: session.sessionId,
          ...payload,
        });
        return;
      }

      await submitAgentIceCandidate({
        agentId: session.agentId,
        streamId: session.streamId,
        sessionId: session.sessionId,
        ...payload,
      });
    },
    [],
  );

  const disableDidPlayback = useCallback(async () => {
    setDidPlaybackUnavailable(true);
    setReplyStatusText(null);

    if (liveSessionRef.current?.provider === "did") {
      await disconnectLiveStream();
    }

    if (!didCreditsAlertShownRef.current) {
      didCreditsAlertShownRef.current = true;
      Alert.alert(
        "D-ID credits exhausted",
        "Avatar video is unavailable right now. Replies will continue with audio only.",
      );
    }
  }, [disconnectLiveStream]);

  const playLiveBackendAudio = useCallback(
    (text: string) => {
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
              }
            },
          );
        })
        .catch((err) => {
          console.warn("[TTS] live backend audio error:", err);
          setIsSpeaking(false);
        });
    },
    [ttsPlayer],
  );

  const speakLiveReply = useCallback(
    async (text: string) => {
      const session = liveSessionRef.current;
      if (!session) {
        throw new Error("Live stream is not connected.");
      }

      if (session.provider === "backend") {
        await Promise.all([
          speakLiveAvatarText({
            sessionId: session.sessionId,
            text,
          }),
          Promise.resolve(playLiveBackendAudio(text)),
        ]);
        return;
      }

      await createAgentVideoStream({
        ...session,
        text,
      });
    },
    [playLiveBackendAudio],
  );

  const startLiveStream = useCallback(async () => {
    if (!avatar || isLiveConnecting) return;
    if (!liveBackendConfigured && didPlaybackUnavailableRef.current) {
      Alert.alert(
        "D-ID unavailable",
        "Live avatar is unavailable right now because the D-ID account has no remaining credits.",
      );
      return;
    }

    setIsLiveConnecting(true);
    setLiveStatusText("Preparing live avatar…");

    try {
      await disconnectLiveStream();

      let liveOffer: { type: string; sdp: string };
      let iceServers:
        | Array<{
            urls: string | string[];
            username?: string;
            credential?: string;
          }>
        | undefined;

      if (liveBackendConfigured) {
        setLiveStatusText("Preparing live avatar…");
        const sourceInput = await getLiveAvatarSourceInput();
        setLiveStatusText("Opening live stream…");
        const streamSession = await createLiveAvatarSession({
          avatarId: avatar.id,
          avatarName: avatar.name,
          ...sourceInput,
        });
        liveSessionRef.current = {
          provider: "backend",
          sessionId: streamSession.sessionId,
        };
        liveOffer = streamSession.offer;
        iceServers = streamSession.iceServers;
      } else {
        const didImageUrl = await getDidSourceUrl();

        let agentId = liveAgentIdRef.current;
        if (!agentId) {
          setLiveStatusText("Creating D-ID agent…");
          agentId = await createAgentFromPhoto({
            name: avatar.name,
            sourceUrl: didImageUrl,
          });
          liveAgentIdRef.current = agentId;
        }

        setLiveStatusText("Opening live stream…");
        const streamSession = await createAgentStream(agentId);
        liveSessionRef.current = {
          provider: "did",
          agentId: streamSession.agentId,
          streamId: streamSession.streamId,
          sessionId: streamSession.sessionId,
        };
        liveOffer = streamSession.offer;
        iceServers = streamSession.iceServers;
      }

      const activeSession = liveSessionRef.current;
      if (!activeSession) {
        throw new Error("Live session was not created.");
      }

      const peerConnection = new RTCPeerConnection({
        iceServers,
      });
      livePeerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (event.track?.kind !== "video") {
          return;
        }

        const attachRemoteTrack = () => {
          const nextStream = new MediaStream();
          nextStream.addTrack(event.track);
          setLiveRemoteStream(nextStream);
          setIsLiveMode(true);
          setLiveStatusText("Live");
          setIsLiveConnecting(false);
        };

        attachRemoteTrack();
        event.track.onunmute = attachRemoteTrack;
      };

      peerConnection.onconnectionstatechange = () => {
        const nextState = peerConnection.connectionState;
        if (nextState === "connected") {
          setIsLiveMode(true);
          setLiveStatusText("Live");
          setIsLiveConnecting(false);
          return;
        }

        if (nextState === "connecting") {
          setLiveStatusText("Connecting…");
          return;
        }

        if (
          nextState === "failed" ||
          nextState === "disconnected" ||
          nextState === "closed"
        ) {
          setIsLiveMode(false);
          setLiveStatusText(nextState === "failed" ? "Live failed" : "Offline");
        }
      };

      peerConnection.onicecandidate = (event) => {
        const session = liveSessionRef.current;
        if (!session) return;

        const payload = {
          candidate: event.candidate?.candidate ?? null,
          sdpMid: event.candidate?.sdpMid ?? null,
          sdpMLineIndex: event.candidate?.sdpMLineIndex ?? null,
        };

        if (!peerConnection.localDescription) {
          pendingIceCandidatesRef.current.push(payload);
          return;
        }

        void submitCurrentLiveIceCandidate(session, payload).catch((err) => {
          console.warn("[Live Avatar] ICE error:", err);
        });
      };

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(liveOffer),
      );

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      if (!answer.sdp || !answer.type) {
        throw new Error("WebRTC answer was incomplete.");
      }

      if (activeSession.provider === "backend") {
        await submitLiveAvatarAnswer({
          sessionId: activeSession.sessionId,
          answer: {
            type: answer.type,
            sdp: answer.sdp,
          },
        });
      } else {
        await startAgentConnection({
          agentId: activeSession.agentId,
          streamId: activeSession.streamId,
          sessionId: activeSession.sessionId,
          answer: {
            type: answer.type,
            sdp: answer.sdp,
          },
        });
      }

      const queuedIceCandidates = [...pendingIceCandidatesRef.current];
      pendingIceCandidatesRef.current = [];

      await Promise.all(
        queuedIceCandidates.map((candidate) =>
          submitCurrentLiveIceCandidate(activeSession, candidate).catch(
            (err) => {
              console.warn("[Live Avatar] flush ICE error:", err);
            },
          ),
        ),
      );
    } catch (err) {
      await disconnectLiveStream();
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert(
        "Live stream failed",
        liveBackendConfigured
          ? `${msg}\n\nSet EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL to your signaling backend and make sure the Runpod live service is online.`
          : `${msg}\n\nIf agent creation still fails, set EXPO_PUBLIC_DID_AGENT_ID in .env to an existing D-ID agent id and try again.`,
      );
    } finally {
      setIsLiveConnecting(false);
    }
  }, [
    avatar,
    disconnectLiveStream,
    getDidSourceUrl,
    getLiveAvatarSourceInput,
    isLiveConnecting,
    liveBackendConfigured,
    submitCurrentLiveIceCandidate,
  ]);

  const toggleLiveStream = useCallback(async () => {
    if (isLiveMode || isLiveConnecting) {
      await disconnectLiveStream();
      return;
    }

    await startLiveStream();
  }, [disconnectLiveStream, isLiveConnecting, isLiveMode, startLiveStream]);

  useEffect(() => {
    return () => {
      void disconnectLiveStream();
    };
  }, [disconnectLiveStream]);

  const animateAvatarReplyAndWait = useCallback(
    async (text: string) => {
      if (!avatar) throw new Error("Avatar not found.");

      setIsSpeaking(true);
      try {
        setReplyStatusText("Generating voice…");
        const [didImageUrl, audioUri] = await Promise.all([
          getDidSourceUrl(),
          textToSpeech(text),
        ]);
        setReplyStatusText("Uploading voice…");
        const didAudioUrl = await uploadAudioToDID(audioUri);
        setReplyStatusText("Rendering avatar…");
        const talkId = await createTalkFromAudio(
          didImageUrl,
          didAudioUrl,
          `${avatar.name}-${Date.now()}`,
        );
        const videoUrl = await pollTalk(talkId);
        setReplyStatusText("Playing reply…");
        updateAvatarVideoUrl(avatar.id, videoUrl);
        await playAvatarReplyVideo(videoUrl);
      } finally {
        setIsSpeaking(false);
        setReplyStatusText(null);
      }
    },
    [avatar, getDidSourceUrl, playAvatarReplyVideo, updateAvatarVideoUrl],
  );

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

  useFocusEffect(
    useCallback(() => {
      return scrollToLatest(false);
    }, [chatMessages.length, composerHeight, scrollToLatest]),
  );

  const handleReAnimate = async () => {
    if (!avatar || isAnimating) return;
    if (didPlaybackUnavailableRef.current) {
      Alert.alert(
        "D-ID unavailable",
        "D-ID video is unavailable right now because the account has no remaining credits.",
      );
      return;
    }
    setIsAnimating(true);
    try {
      // Download the Firebase-hosted avatar image to a local temp file so
      // D-ID's Rekognition service can analyse it via their own /images endpoint.
      const tempUri =
        (FileSystem.cacheDirectory ?? "") + avatar.id + "_reanimate.jpg";
      await FileSystem.downloadAsync(avatar.imageUri, tempUri);
      const didImageUrl = await uploadImageToDID(tempUri);
      const talkId = await createTalk(didImageUrl);
      const videoUrl = await pollTalk(talkId);
      updateAvatarVideoUrl(avatar.id, videoUrl);
      videoPlayer.replace(videoUrl);
      videoPlayer.play();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("Animation failed", msg);
    } finally {
      setIsAnimating(false);
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isSending || !!replyStatusText) return;
    if (coins <= 0) {
      setShowNoCoins(true);
      return;
    }
    setInputText("");
    setIsSending(true);
    spendCoin();
    try {
      const reply = await sendMessage(id ?? "", text);
      setIsSending(false);
      try {
        if (liveSessionRef.current) {
          await speakLiveReply(reply);
        } else if (didPlaybackUnavailableRef.current) {
          void speakReply(reply);
        } else {
          await animateAvatarReplyAndWait(reply);
        }
      } catch (avatarErr) {
        console.warn("[Avatar] reply playback error:", avatarErr);
        if (isDidCreditsError(avatarErr)) {
          await disableDidPlayback();
        }
        void speakReply(reply);
      }
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
        "recorderStatusUpdate",
        (status: { metering?: number }) => {
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

      setLastVoiceTranscript(transcript);

      if (coinsRef.current <= 0) {
        setShowNoCoins(true);
        setIsVoiceMode(false);
        return;
      }
      spendCoin();
      setIsSending(true);
      const reply = await sendMessage(id ?? "", transcript);
      setIsSending(false);
      setTimeout(
        () => flatListRef.current?.scrollToEnd({ animated: true }),
        100,
      );

      if (!isVoiceSessionActive(sessionId)) return;
      setVoicePhase("speaking");
      try {
        if (liveSessionRef.current) {
          await speakLiveReply(reply);
        } else if (didPlaybackUnavailableRef.current) {
          await speakReplyAndWait(reply);
        } else {
          await animateAvatarReplyAndWait(reply);
        }
      } catch (avatarErr) {
        console.warn("[Avatar] animate voice reply error:", avatarErr);
        if (isDidCreditsError(avatarErr)) {
          await disableDidPlayback();
        }
        await speakReplyAndWait(reply);
      }
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
        void startVoiceListening(sessionId);
      }
    }
  };

  const stopVoiceMode = useCallback(() => {
    voiceSessionIdRef.current += 1;
    setIsVoiceMode(false);
  }, []);

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
      <Animated.View
        style={[
          styles.avatarPanel,
          liveRemoteStream ? null : { opacity: pulseAnim },
          Platform.OS === "android" && liveRemoteStream
            ? styles.avatarPanelLiveAndroid
            : null,
        ]}
      >
        {liveRemoteStream ? (
          <RTCView
            key={liveRemoteStream.toURL()}
            streamURL={liveRemoteStream.toURL()}
            style={[styles.avatarPanelImage, styles.avatarPanelRtcView]}
            objectFit="cover"
            mirror={false}
            zOrder={0}
            collapsable={false}
          />
        ) : displayedVideoUrl ? (
          <VideoView
            player={videoPlayer}
            style={styles.avatarPanelImage}
            contentFit="cover"
            nativeControls={false}
          />
        ) : (
          <Image
            source={{ uri: avatar.imageUri }}
            style={styles.avatarPanelImage}
          />
        )}
        {!liveRemoteStream ? <View style={styles.avatarPanelOverlay} /> : null}
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
          {!avatar.videoUrl && (
            <TouchableOpacity
              style={[
                styles.animateBtn,
                isAnimating && styles.animateBtnBusy,
                didPlaybackUnavailable && styles.featureBtnDisabled,
              ]}
              onPress={handleReAnimate}
              disabled={isAnimating || didPlaybackUnavailable}
              activeOpacity={0.8}
            >
              {isAnimating ? (
                <ActivityIndicator size="small" color={Colors.white} />
              ) : (
                <Text style={styles.animateBtnText}>✨ Animate</Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[
              styles.liveBtn,
              (isLiveMode || isLiveConnecting) && styles.liveBtnActive,
              !liveBackendConfigured &&
                didPlaybackUnavailable &&
                styles.featureBtnDisabled,
            ]}
            onPress={toggleLiveStream}
            disabled={
              isAnimating || (!liveBackendConfigured && didPlaybackUnavailable)
            }
            activeOpacity={0.8}
          >
            {isLiveConnecting ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Text style={styles.liveBtnText}>
                {isLiveMode ? "🟢 Live" : "Live"}
              </Text>
            )}
          </TouchableOpacity>
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
          {isLiveMode || isLiveConnecting ? (
            <View style={styles.liveStatusRow}>
              <View
                style={[
                  styles.liveDot,
                  isLiveConnecting && styles.liveDotConnecting,
                ]}
              />
              <Text style={styles.liveStatusText}>{liveStatusText}</Text>
            </View>
          ) : null}
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
          renderItem={({ item }) => (
            <View
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
            </View>
          )}
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
  avatarPanelRtcView: {
    backgroundColor: "#000",
  },
  avatarPanelOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13,13,26,0.40)",
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
