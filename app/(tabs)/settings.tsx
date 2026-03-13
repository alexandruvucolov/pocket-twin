import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Image,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useAvatars } from "@/context/AvatarContext";

function SettingsRow({
  emoji,
  label,
  value,
  onPress,
  danger = false,
}: {
  emoji: string;
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.rowEmoji}>{emoji}</Text>
        <Text style={[styles.rowLabel, danger && styles.rowLabelDanger]}>
          {label}
        </Text>
      </View>
      {value ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={Colors.textMuted} />
      )}
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { avatars, coins, clearAvatars } = useAvatars();
  const insets = useSafeAreaInsets();

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => {
          signOut();
          router.replace("/(auth)/login");
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 58 + insets.bottom + 16 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
        </View>

        {/* Profile Card */}
        <View style={styles.profileCard}>
          {user?.photoURL ? (
            <Image source={{ uri: user.photoURL }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarInitial}>
                {user?.displayName?.[0]?.toUpperCase() ?? "?"}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>
              {user?.displayName ?? "User"}
            </Text>
            <Text style={styles.profileEmail}>{user?.email}</Text>
          </View>
          <View style={styles.coinTag}>
            <Text style={styles.coinTagText}>🪙 {coins}</Text>
          </View>
        </View>

        {/* Account Section */}
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.section}>
          <SettingsRow
            emoji="👤"
            label="Edit Profile"
            onPress={() => router.push("/profile")}
          />
          <View style={styles.divider} />
          <SettingsRow
            emoji="🪙"
            label="Buy Coins"
            onPress={() => router.push("/buy-coins")}
          />
          <View style={styles.divider} />
          <SettingsRow
            emoji="🪞"
            label="Avatars Created"
            value={`${avatars.length}`}
          />
        </View>

        {/* App Section */}
        <Text style={styles.sectionLabel}>App</Text>
        <View style={styles.section}>
          <SettingsRow
            emoji="ℹ️"
            label="About Pocket Twin"
            onPress={() =>
              Alert.alert(
                "About",
                "Pocket Twin v1.0\nSnap · Animate · Chat\n\nThis is an MVP build.",
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            emoji="📧"
            label="Contact Support"
            onPress={() =>
              Alert.alert("Support", "Email us at hello@pockettwin.app")
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            emoji="⭐"
            label="Rate the App"
            onPress={() =>
              Alert.alert(
                "Thanks!",
                "Rating will be available on the App Store 🙏",
              )
            }
          />
        </View>

        {/* Danger Zone */}
        <Text style={styles.sectionLabel}>Danger Zone</Text>
        <View style={styles.section}>
          <SettingsRow
            emoji="🗑️"
            label="Delete All Avatars"
            danger
            onPress={() =>
              Alert.alert(
                "Delete All",
                "This will permanently delete all avatars.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                      try {
                        await clearAvatars();
                        Alert.alert("Done", "All avatars were deleted.");
                      } catch {
                        Alert.alert(
                          "Delete failed",
                          "Could not delete avatars. Please try again.",
                        );
                      }
                    },
                  },
                ],
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            emoji="🚪"
            label="Sign Out"
            danger
            onPress={handleLogout}
          />
        </View>

        <Text style={styles.version}>Pocket Twin MVP · v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scroll: {
    paddingHorizontal: 24,
  },
  header: {
    paddingTop: 20,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.text,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 18,
    padding: 16,
    marginBottom: 28,
    gap: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: {
    color: Colors.white,
    fontSize: 24,
    fontWeight: "800",
  },
  profileName: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  profileEmail: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  coinTag: {
    backgroundColor: Colors.surfaceHigh,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  coinTagText: {
    color: Colors.gold,
    fontWeight: "700",
    fontSize: 14,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowEmoji: {
    fontSize: 18,
  },
  rowLabel: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  rowLabelDanger: {
    color: Colors.error,
  },
  rowValue: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: 48,
  },
  version: {
    textAlign: "center",
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 8,
  },
});
