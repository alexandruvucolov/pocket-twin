import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
  Dimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../../../src/constants/colors";
import { useAvatars } from "../../../src/context/AvatarContext";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const AVATAR_PANEL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { avatars, coins, messages, sendMessage, spendCoin } = useAvatars();
  const insets = useSafeAreaInsets();

  const avatar = avatars.find((a: { id: string }) => a.id === id);
  const chatMessages = messages[id ?? ""] ?? [];

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showNoCoins, setShowNoCoins] = useState(false);
  const flatListRef = useRef<FlatList>(null);

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
    await sendMessage(id ?? "", text);
    setIsSending(false);

    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "android" ? -insets.bottom : 0}
      >
        {/* ── Avatar panel (top 42%) ── */}
        <Animated.View
          style={[styles.avatarPanel, { transform: [{ scale: pulseAnim }] }]}
        >
          <Image
            source={{ uri: avatar.imageUri }}
            style={styles.avatarPanelImage}
          />
          {/* dark gradient overlay at bottom of panel */}
          <View style={styles.avatarPanelOverlay} />

          {/* header overlaid on avatar */}
          <View
            style={[styles.header, { paddingTop: insets.top > 0 ? 0 : 12 }]}
          >
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
              <Text
                style={[styles.coinCount, coins <= 2 && styles.coinCountLow]}
              >
                {coins}
              </Text>
              {coins <= 2 && <Text style={styles.buyMore}>+ Buy</Text>}
            </TouchableOpacity>
          </View>

          {/* avatar name + status at bottom of panel */}
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
        </Animated.View>

        {/* ── Chat bottom half ── */}
        <View style={styles.chatPane}>
          <FlatList
            ref={flatListRef}
            data={chatMessages}
            keyExtractor={(_, i) => i.toString()}
            contentContainerStyle={styles.messageList}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() =>
              flatListRef.current?.scrollToEnd({ animated: true })
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
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatEmoji}>👋</Text>
                <Text style={styles.emptyChatText}>
                  Say hello to {avatar.name}!
                </Text>
              </View>
            }
          />

          {/* Input bar */}
          <View style={[styles.inputBar, { paddingBottom: insets.bottom + 4 }]}>
            <TextInput
              style={styles.input}
              placeholder={`Message ${avatar.name}...`}
              placeholderTextColor={Colors.textMuted}
              value={inputText}
              onChangeText={setInputText}
              multiline
              maxLength={500}
              onSubmitEditing={handleSend}
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
      </KeyboardAvoidingView>

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
              <Text style={styles.buyButtonText}>Buy Coins</Text>
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

  // ── Avatar panel ──
  avatarPanel: {
    width: "100%",
    height: AVATAR_PANEL_HEIGHT,
    backgroundColor: Colors.surface,
    overflow: "hidden",
  },
  avatarPanelImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  avatarPanelOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13,13,26,0.45)",
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
  },
  backButton: {
    padding: 4,
  },
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
  coinCount: {
    color: Colors.gold,
    fontWeight: "700",
    fontSize: 14,
  },
  coinCountLow: {
    color: Colors.error,
  },
  buyMore: {
    color: "#a78bfa",
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 2,
  },
  avatarMeta: {
    position: "absolute",
    bottom: 14,
    left: 16,
    gap: 4,
  },
  avatarPanelName: {
    color: Colors.white,
    fontSize: 22,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  thinkingText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontStyle: "italic",
  },
  onlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#22c55e",
  },
  onlineText: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
  },

  // ── Chat pane ──
  chatPane: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  messageList: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
  },
  bubble: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  bubbleUser: {
    justifyContent: "flex-end",
  },
  bubbleBot: {
    justifyContent: "flex-start",
  },
  bubbleAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
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
  bubbleMsg: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  bubbleMsgUser: {
    color: Colors.white,
  },
  emptyChat: {
    alignItems: "center",
    paddingTop: 24,
    gap: 8,
  },
  emptyChatEmoji: {
    fontSize: 36,
  },
  emptyChatText: {
    color: Colors.textSecondary,
    fontSize: 15,
  },

  // ── Input bar ──
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
  noCoinsTitle: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: "800",
  },
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
  buyButtonText: {
    color: Colors.white,
    fontWeight: "700",
    fontSize: 16,
  },
  dismissText: {
    color: Colors.textMuted,
    fontSize: 13,
    marginTop: 4,
  },

  // ── Not found ──
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  notFoundText: {
    color: Colors.text,
    fontSize: 18,
  },
  backBtn: { padding: 12 },
  backBtnText: {
    color: Colors.primary,
    fontSize: 16,
  },
});
