import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { uploadProfilePhoto } from "@/lib/firebase";

export default function ProfileScreen() {
  const router = useRouter();
  const { user, updateUserProfile } = useAuth();
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [localPhotoURI, setLocalPhotoURI] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("front");

  const cameraRef = useRef<CameraView>(null);
  const originalName = useRef(user?.displayName ?? "");
  const originalPhoto = useRef(user?.photoURL ?? null);

  const nameChanged = displayName.trim() !== originalName.current;
  const photoChanged = localPhotoURI !== null;
  const hasChanges = nameChanged || photoChanged;

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName ?? "");
      originalName.current = user.displayName ?? "";
      originalPhoto.current = user.photoURL ?? null;
    }
  }, [user?.id]);

  const handleChangePhoto = () => {
    Alert.alert("Change Photo", "Choose how to update your profile picture", [
      {
        text: "Take Selfie",
        onPress: openCamera,
      },
      {
        text: "Choose from Gallery",
        onPress: pickFromGallery,
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const openCamera = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert(
          "Permission needed",
          "Please allow camera access to take a selfie.",
        );
        return;
      }
    }
    setShowCamera(true);
  };

  const captureSelfie = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
        mirror: false,
      });
      if (photo?.uri) {
        setLocalPhotoURI(photo.uri);
        setShowCamera(false);
      }
    } catch (err) {
      console.warn("[Profile] Capture failed:", err);
      Alert.alert("Error", "Could not capture photo. Please try again.");
    }
  };

  const pickFromGallery = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Please allow photo library access to change your profile picture.",
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]?.uri) {
      setLocalPhotoURI(result.assets[0].uri);
    }
  };

  const handleSave = async () => {
    if (!hasChanges || isSaving) return;

    const name = displayName.trim();
    if (!name) {
      Alert.alert("Name required", "Please enter a display name.");
      return;
    }

    setIsSaving(true);
    try {
      let photoURL: string | undefined;

      if (photoChanged && localPhotoURI && user?.id) {
        photoURL = await uploadProfilePhoto({
          userId: user.id,
          localUri: localPhotoURI,
        });
      }

      await updateUserProfile(name, photoURL);

      originalName.current = name;
      setLocalPhotoURI(null);
      Alert.alert("Saved", "Your profile has been updated.");
    } catch (err) {
      console.warn("[Profile] Save failed:", err);
      Alert.alert("Save failed", "Could not update profile. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const photoSource = localPhotoURI
    ? { uri: localPhotoURI }
    : user?.photoURL
      ? { uri: user.photoURL }
      : null;

  const initial = (user?.displayName ?? "?")[0]?.toUpperCase();

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={styles.headerRight} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Avatar */}
          <View style={styles.avatarSection}>
            <TouchableOpacity
              style={styles.avatarWrap}
              onPress={handleChangePhoto}
              activeOpacity={0.8}
            >
              {photoSource ? (
                <Image source={photoSource} style={styles.avatar} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarInitial}>{initial}</Text>
                </View>
              )}
              <View style={styles.cameraOverlay}>
                <Ionicons name="camera" size={18} color={Colors.white} />
              </View>
            </TouchableOpacity>
            <Text style={styles.changePhotoHint}>Tap to change photo</Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            {/* Display Name */}
            <Text style={styles.fieldLabel}>Display Name</Text>
            <TextInput
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Your name"
              placeholderTextColor={Colors.textMuted}
              autoCapitalize="words"
              returnKeyType="done"
              maxLength={40}
            />

            {/* Email (read-only) */}
            <Text style={styles.fieldLabel}>Email</Text>
            <View style={styles.inputReadOnly}>
              <Text style={styles.inputReadOnlyText}>{user?.email ?? "—"}</Text>
              <Ionicons name="lock-closed" size={14} color={Colors.textMuted} />
            </View>
          </View>

          {/* Save Button */}
          <TouchableOpacity
            style={[
              styles.saveBtn,
              (!hasChanges || isSaving) && styles.saveBtnDisabled,
            ]}
            onPress={handleSave}
            activeOpacity={0.8}
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? (
              <ActivityIndicator color={Colors.white} size="small" />
            ) : (
              <Text style={styles.saveBtnText}>Save Changes</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
      {/* In-app camera overlay */}
      {showCamera && (
        <View style={StyleSheet.absoluteFill}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={cameraFacing}
            mirror={false}
          />

          {/* Top row */}
          <View style={[styles.camTopRow, { paddingTop: insets.top + 8 }]}>
            <TouchableOpacity
              style={styles.camIconBtn}
              onPress={() => setShowCamera(false)}
              activeOpacity={0.8}
            >
              <Ionicons name="chevron-back" size={26} color={Colors.white} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.camIconBtn}
              onPress={() =>
                setCameraFacing((f) => (f === "front" ? "back" : "front"))
              }
              activeOpacity={0.8}
            >
              <Ionicons
                name="camera-reverse-outline"
                size={26}
                color={Colors.white}
              />
            </TouchableOpacity>
          </View>

          {/* Circular crop guide */}
          <View style={styles.camGuideLayer} pointerEvents="none">
            <View style={styles.camGuideCircle} />
            <Text style={styles.camGuideHint}>Center your face</Text>
          </View>

          {/* Capture button */}
          <View
            style={[
              styles.camBottomBar,
              { marginBottom: Math.max(24, insets.bottom + 20) },
            ]}
          >
            <TouchableOpacity
              style={styles.camCaptureBtn}
              onPress={captureSelfie}
              activeOpacity={0.85}
            >
              <View style={styles.camCaptureBtnInner} />
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: {
    padding: 4,
    marginRight: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
  },
  headerRight: {
    width: 32,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 48,
  },
  avatarSection: {
    alignItems: "center",
    marginBottom: 40,
  },
  avatarWrap: {
    position: "relative",
    marginBottom: 10,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: Colors.primary,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: Colors.primaryLight,
  },
  avatarInitial: {
    color: Colors.white,
    fontSize: 40,
    fontWeight: "800",
  },
  cameraOverlay: {
    position: "absolute",
    bottom: 0,
    right: 0,
    backgroundColor: Colors.surfaceHigh,
    borderRadius: 16,
    padding: 6,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  changePhotoHint: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  form: {
    gap: 6,
    marginBottom: 32,
  },
  fieldLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 4,
    marginTop: 16,
    marginLeft: 4,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: Colors.text,
    fontSize: 16,
    fontWeight: "500",
  },
  inputReadOnly: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    opacity: 0.7,
  },
  inputReadOnlyText: {
    color: Colors.textSecondary,
    fontSize: 16,
  },
  saveBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  saveBtnDisabled: {
    opacity: 0.4,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveBtnText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: "700",
  },
  // ─── In-app camera ───────────────────────────────────────────
  camTopRow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  camIconBtn: {
    backgroundColor: "rgba(0,0,0,0.45)",
    borderRadius: 24,
    padding: 8,
  },
  camGuideLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  camGuideCircle: {
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.6)",
    backgroundColor: "transparent",
  },
  camGuideHint: {
    marginTop: 16,
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    fontWeight: "600",
  },
  camBottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  camCaptureBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: Colors.white,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  camCaptureBtnInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: Colors.white,
  },
});
