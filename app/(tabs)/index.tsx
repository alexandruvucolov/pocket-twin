import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  Dimensions,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../../src/constants/colors";
import { useAuth } from "../../src/context/AuthContext";
import { useAvatars } from "../../src/context/AvatarContext";
import { Avatar } from "../../src/constants/dummy";

const { width } = Dimensions.get("window");
const CARD_WIDTH = (width - 24 * 2 - 12) / 2;

function AvatarCard({
  avatar,
  onPress,
}: {
  avatar: Avatar;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Image source={{ uri: avatar.imageUri }} style={styles.cardImage} />
      <View style={styles.cardOverlay}>
        <Text style={styles.cardName} numberOfLines={1}>
          {avatar.name}
        </Text>
        <Text style={styles.cardMeta}>
          {avatar.messageCount > 0 ? `${avatar.messageCount} msgs` : "New"}
        </Text>
      </View>
      {avatar.lastChatAt && <View style={styles.activeDot} />}
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { avatars, coins } = useAvatars();
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>
            Hello, {user?.displayName ?? "there"} 👋
          </Text>
          <Text style={styles.subtitle}>Who do you want to chat with?</Text>
        </View>
        <TouchableOpacity
          style={styles.coinBadge}
          onPress={() => router.push("/buy-coins")}
        >
          <Text style={styles.coinEmoji}>🪙</Text>
          <Text style={styles.coinCount}>{coins}</Text>
        </TouchableOpacity>
      </View>

      {/* Create New Avatar CTA */}
      <TouchableOpacity
        style={styles.createButton}
        onPress={() => router.push("/upload")}
        activeOpacity={0.88}
      >
        <View style={styles.createInner}>
          <Text style={styles.createEmoji}>📷</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.createTitle}>Create New Avatar</Text>
            <Text style={styles.createSub}>
              Snap a selfie & bring it to life
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.white} />
        </View>
      </TouchableOpacity>

      {/* Avatars */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Your Avatars</Text>
        <Text style={styles.sectionCount}>{avatars.length}</Text>
      </View>

      {avatars.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>🪞</Text>
          <Text style={styles.emptyText}>No avatars yet.</Text>
          <Text style={styles.emptySubtext}>
            Tap "Create New Avatar" to get started!
          </Text>
        </View>
      ) : (
        <FlatList
          data={avatars}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={[
            styles.grid,
            { paddingBottom: 58 + insets.bottom + 16 },
          ]}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <AvatarCard
              avatar={item}
              onPress={() => router.push(`/chat/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 16,
  },
  greeting: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  coinBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  coinEmoji: {
    fontSize: 16,
  },
  coinCount: {
    color: Colors.gold,
    fontWeight: "700",
    fontSize: 16,
  },
  createButton: {
    marginHorizontal: 24,
    marginBottom: 24,
    backgroundColor: Colors.primary,
    borderRadius: 18,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  createInner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    gap: 16,
  },
  createEmoji: {
    fontSize: 28,
  },
  createTitle: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
  createSub: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    marginTop: 2,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    marginBottom: 12,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  sectionCount: {
    backgroundColor: Colors.surfaceHigh,
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  grid: {
    paddingHorizontal: 24,
  },
  row: {
    gap: 12,
    marginBottom: 12,
  },
  card: {
    width: CARD_WIDTH,
    height: CARD_WIDTH * 1.25,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: Colors.surface,
  },
  cardImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  cardOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    padding: 10,
  },
  cardName: {
    color: Colors.white,
    fontWeight: "700",
    fontSize: 14,
  },
  cardMeta: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 11,
    marginTop: 1,
  },
  activeDot: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.success,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 80,
  },
  emptyEmoji: {
    fontSize: 56,
    marginBottom: 8,
  },
  emptyText: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  emptySubtext: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
