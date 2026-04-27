import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Image,
  Linking,
  Modal,
  TextInput,
  ActivityIndicator,
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
  icon,
  label,
  value,
  onPress,
  danger = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
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
        <View style={[styles.rowIconWrap, danger && styles.rowIconWrapDanger]}>
          <Ionicons
            name={icon}
            size={18}
            color={danger ? "#ef4444" : Colors.textSecondary}
          />
        </View>
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
  const { user, signOut, deleteAccount, reAuthAndDelete, isGoogleUser } = useAuth();
  const { avatars, coins, clearAvatars } = useAvatars();
  const insets = useSafeAreaInsets();

  const [reAuthVisible, setReAuthVisible] = useState(false);
  const [reAuthPassword, setReAuthPassword] = useState("");
  const [reAuthLoading, setReAuthLoading] = useState(false);
  const [reAuthError, setReAuthError] = useState("");
  const [showReAuthPassword, setShowReAuthPassword] = useState(false);

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "This will permanently delete your account and all your data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Account",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteAccount();
              router.replace("/(auth)/login");
            } catch (err: unknown) {
              const code = (err as { code?: string })?.code ?? "";
              if (code === "auth/requires-recent-login") {
                // Need to re-authenticate first
                setReAuthPassword("");
                setReAuthError("");
                setReAuthVisible(true);
              } else {
                Alert.alert("Error", "Could not delete account. Please try again.");
              }
            }
          },
        },
      ],
    );
  };

  const handleReAuthAndDelete = async () => {
    setReAuthError("");
    setReAuthLoading(true);
    try {
      await reAuthAndDelete(reAuthPassword || undefined);
      setReAuthVisible(false);
      router.replace("/(auth)/login");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
        setReAuthError("Incorrect password. Please try again.");
      } else if (code === "SIGN_IN_CANCELLED" || code === "sign_in_cancelled") {
        // Google re-auth cancelled — just close
        setReAuthVisible(false);
      } else {
        setReAuthError("Re-authentication failed. Please try again.");
      }
    } finally {
      setReAuthLoading(false);
    }
  };

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await signOut();
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
            icon="person-outline"
            label="Edit Profile"
            onPress={() => router.push("/profile")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="wallet-outline"
            label="Buy Coins"
            onPress={() => router.push("/buy-coins")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="images-outline"
            label="Avatars Created"
            value={`${avatars.length}`}
          />
        </View>

        {/* App Section */}
        <Text style={styles.sectionLabel}>App</Text>
        <View style={styles.section}>
          <SettingsRow
            icon="information-circle-outline"
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
            icon="lock-closed-outline"
            label="Privacy Policy"
            onPress={() =>
              Linking.openURL(
                "https://alexandruvucolov.github.io/pockettwin-legal/privacy.html",
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="document-text-outline"
            label="Terms of Service"
            onPress={() =>
              Linking.openURL(
                "https://alexandruvucolov.github.io/pockettwin-legal/terms.html",
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="flag-outline"
            label="Report an Issue"
            onPress={() =>
              Linking.openURL(
                "mailto:sales@atech-tools.com?subject=Issue%20Report",
              )
            }
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="mail-outline"
            label="Contact Support"
            onPress={() => Linking.openURL("mailto:sales@atech-tools.com")}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="star-outline"
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
            icon="trash-outline"
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
            icon="person-remove-outline"
            label="Delete Account"
            danger
            onPress={handleDeleteAccount}
          />
          <View style={styles.divider} />
          <SettingsRow
            icon="log-out-outline"
            label="Sign Out"
            danger
            onPress={handleLogout}
          />
        </View>

        <Text style={styles.version}>Pocket Twin MVP · v1.0.0</Text>
      </ScrollView>

      {/* Re-authentication modal shown when deleteAccount throws auth/requires-recent-login */}
      <Modal
        visible={reAuthVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setReAuthVisible(false)}
      >
        <View style={styles.reAuthOverlay}>
          <View style={styles.reAuthCard}>
            <Text style={styles.reAuthTitle}>Confirm Your Identity</Text>
            <Text style={styles.reAuthSubtitle}>
              For security, please re-authenticate before deleting your account.
            </Text>

            {isGoogleUser ? (
              <TouchableOpacity
                style={styles.reAuthGoogleBtn}
                onPress={handleReAuthAndDelete}
                disabled={reAuthLoading}
                activeOpacity={0.8}
              >
                {reAuthLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="logo-google" size={18} color="#fff" style={{ marginRight: 8 }} />
                    <Text style={styles.reAuthGoogleBtnText}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : (
              <>
                <View style={styles.reAuthInputWrap}>
                  <TextInput
                    style={styles.reAuthInput}
                    placeholder="Current password"
                    placeholderTextColor={Colors.textMuted}
                    secureTextEntry={!showReAuthPassword}
                    value={reAuthPassword}
                    onChangeText={(t) => { setReAuthPassword(t); setReAuthError(""); }}
                    autoCapitalize="none"
                    editable={!reAuthLoading}
                  />
                  <TouchableOpacity
                    style={styles.reAuthEye}
                    onPress={() => setShowReAuthPassword((v) => !v)}
                  >
                    <Ionicons
                      name={showReAuthPassword ? "eye-off-outline" : "eye-outline"}
                      size={18}
                      color={Colors.textMuted}
                    />
                  </TouchableOpacity>
                </View>
                {reAuthError ? (
                  <Text style={styles.reAuthError}>{reAuthError}</Text>
                ) : null}
                <TouchableOpacity
                  style={[styles.reAuthConfirmBtn, reAuthLoading && { opacity: 0.6 }]}
                  onPress={handleReAuthAndDelete}
                  disabled={reAuthLoading || !reAuthPassword}
                  activeOpacity={0.8}
                >
                  {reAuthLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.reAuthConfirmBtnText}>Confirm & Delete Account</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={styles.reAuthCancelBtn}
              onPress={() => setReAuthVisible(false)}
              disabled={reAuthLoading}
            >
              <Text style={styles.reAuthCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  rowIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: Colors.surfaceHigh,
    alignItems: "center",
    justifyContent: "center",
  },
  rowIconWrapDanger: {
    backgroundColor: "#3f1212",
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
  reAuthOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  reAuthCard: {
    width: "100%",
    backgroundColor: Colors.surface ?? "#1a1a2e",
    borderRadius: 16,
    padding: 24,
  },
  reAuthTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  reAuthSubtitle: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  reAuthInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.inputBackground ?? Colors.border,
    borderRadius: 10,
    marginBottom: 8,
    paddingHorizontal: 14,
  },
  reAuthInput: {
    flex: 1,
    height: 48,
    color: Colors.text,
    fontSize: 15,
  },
  reAuthEye: {
    padding: 4,
  },
  reAuthError: {
    color: "#ef4444",
    fontSize: 13,
    marginBottom: 12,
  },
  reAuthConfirmBtn: {
    backgroundColor: "#ef4444",
    borderRadius: 10,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 12,
  },
  reAuthConfirmBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  reAuthGoogleBtn: {
    flexDirection: "row",
    backgroundColor: "#4285F4",
    borderRadius: 10,
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  reAuthGoogleBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  reAuthCancelBtn: {
    alignItems: "center",
    paddingVertical: 8,
  },
  reAuthCancelText: {
    color: Colors.textMuted,
    fontSize: 14,
  },
});
