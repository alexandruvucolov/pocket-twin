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
import { Colors } from "../../../src/constants/colors";
import { useAvatars } from "../../../src/context/AvatarContext";
import * as FileSystem from "expo-file-system/legacy";
import { createTalk, pollTalk, uploadImageToDID } from "../../../src/lib/did";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const AVATAR_PANEL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.48);
// How many px the chat section rises above the avatar panel bottom.
// Approx height of 2 message bubbles, so they float visually over the avatar.
const CHAT_OVERLAP = 96;

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

  const videoPlayer = useVideoPlayer(avatar?.videoUrl ?? null, (player) => {
    player.loop = true;
    player.muted = true;
    player.play();
  });

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showNoCoins, setShowNoCoins] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [composerHeight, setComposerHeight] = useState(72);
  const [isAnimating, setIsAnimating] = useState(false);
  const flatListRef = useRef<FlatList>(null);
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
  const messageListBottomPadding =
    composerHeight + composerBottom + (isKeyboardOpen ? 16 : 20);
  const avatarPreviewMessages =
    isKeyboardOpen && chatMessages.length > 4 ? chatMessages.slice(-2) : [];
  const visibleChatMessages = chatMessages;

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
            toValue: 1.03,
            duration: 700,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [isSending]);

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
    if (!text || isSending) return;
    if (coins <= 0) {
      setShowNoCoins(true);
      return;
    }
    setInputText("");
    setIsSending(true);
    spendCoin();
    try {
      await sendMessage(id ?? "", text);
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
        style={[styles.avatarPanel, { transform: [{ scale: pulseAnim }] }]}
      >
        {avatar.videoUrl ? (
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
        <View style={styles.avatarPanelOverlay} />
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
              style={[styles.animateBtn, isAnimating && styles.animateBtnBusy]}
              onPress={handleReAnimate}
              disabled={isAnimating}
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

      {/* ── LAYER 3: Input bar above avatar and chat ── */}
      <View
        style={[
          styles.inputBarWrap,
          {
            bottom: composerBottom,
          },
        ]}
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
          <TouchableOpacity
            style={styles.sendButton}
            onPress={inputText.trim() ? handleSend : undefined}
            disabled={isSending}
            activeOpacity={0.8}
          >
            {inputText.trim() ? (
              <Ionicons
                name="send"
                size={20}
                color={Colors.white}
                style={{ marginLeft: 2 }}
              />
            ) : (
              <Ionicons name="mic" size={22} color={Colors.white} />
            )}
          </TouchableOpacity>
        </View>
      </View>

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
  avatarPanelImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
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
  animateBtnText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "700",
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
