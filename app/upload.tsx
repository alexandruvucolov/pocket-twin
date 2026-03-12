import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
  Dimensions,
  TextInput,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors } from "../src/constants/colors";
import { useAvatars } from "../src/context/AvatarContext";

const { width, height } = Dimensions.get("window");

type Step = "pick" | "preview" | "animating" | "done";

export default function UploadScreen() {
  const router = useRouter();
  const { addAvatar } = useAvatars();

  const [step, setStep] = useState<Step>("pick");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [avatarName, setAvatarName] = useState("");
  const [progress, setProgress] = useState(0);

  const pickFromGallery = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission needed",
        "Allow access to your photo library to continue.",
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "images",
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setStep("preview");
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow camera access to take a selfie.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      cameraType: ImagePicker.CameraType.front,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setStep("preview");
    }
  };

  const handleAnimate = async () => {
    if (!avatarName.trim()) {
      Alert.alert("Name required", "Give your avatar a name first!");
      return;
    }
    setStep("animating");
    setProgress(0);

    // Simulate D-ID API call with progress
    const steps = [15, 35, 55, 70, 85, 100];
    for (const p of steps) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
      setProgress(p);
    }

    // Create the avatar with the user's photo
    addAvatar({
      id: Date.now().toString(),
      name: avatarName.trim(),
      imageUri: imageUri!,
      createdAt: new Date(),
      messageCount: 0,
    });

    setStep("done");
  };

  const handleDone = () => {
    router.replace("/(tabs)");
  };

  // ── Step: Pick ───────────────────────────────────────────────────────────
  if (step === "pick") {
    return (
      <SafeAreaView style={styles.root}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={() => router.back()}
        >
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>

        <View style={styles.heroSection}>
          <Text style={styles.heroEmoji}>🪄</Text>
          <Text style={styles.heroTitle}>Create Your{"\n"}Pocket Twin</Text>
          <Text style={styles.heroSub}>One photo is all it takes</Text>
        </View>

        <View style={styles.optionsContainer}>
          <TouchableOpacity
            style={styles.optionCard}
            onPress={takePhoto}
            activeOpacity={0.85}
          >
            <View style={styles.optionIcon}>
              <Text style={styles.optionEmoji}>📷</Text>
            </View>
            <Text style={styles.optionTitle}>Take Selfie</Text>
            <Text style={styles.optionSub}>Use front camera</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.optionCard}
            onPress={pickFromGallery}
            activeOpacity={0.85}
          >
            <View style={styles.optionIcon}>
              <Text style={styles.optionEmoji}>🖼️</Text>
            </View>
            <Text style={styles.optionTitle}>From Gallery</Text>
            <Text style={styles.optionSub}>Pick an existing photo</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tipBox}>
          <Text style={styles.tipText}>
            💡 Best results: clear face, good lighting, looking straight ahead
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Step: Preview ────────────────────────────────────────────────────────
  if (step === "preview") {
    return (
      <SafeAreaView style={styles.root}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={() => setStep("pick")}
        >
          <Text style={styles.closeText}>←</Text>
        </TouchableOpacity>

        <Text style={styles.previewTitle}>Looking good! 🎉</Text>
        <Text style={styles.previewSub}>
          Give your twin a name, then animate
        </Text>

        <View style={styles.previewImageWrap}>
          <Image source={{ uri: imageUri! }} style={styles.previewImage} />
          <TouchableOpacity
            style={styles.retakeButton}
            onPress={() => {
              setImageUri(null);
              setStep("pick");
            }}
          >
            <Text style={styles.retakeText}>Retake</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.nameField}>
          <Text style={styles.nameLabel}>Avatar Name</Text>
          <TextInput
            style={styles.nameInput}
            placeholder='e.g. "My Work Twin"'
            placeholderTextColor={Colors.textMuted}
            value={avatarName}
            onChangeText={setAvatarName}
            maxLength={24}
            autoFocus
          />
        </View>

        <TouchableOpacity
          style={[
            styles.animateButton,
            !avatarName.trim() && styles.animateButtonDisabled,
          ]}
          onPress={handleAnimate}
          disabled={!avatarName.trim()}
          activeOpacity={0.88}
        >
          <Text style={styles.animateButtonText}>✨ Animate Me!</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Step: Animating ──────────────────────────────────────────────────────
  if (step === "animating") {
    return (
      <SafeAreaView style={[styles.root, styles.center]}>
        <Image source={{ uri: imageUri! }} style={styles.animatingImage} />
        <ActivityIndicator
          size="large"
          color={Colors.primary}
          style={{ marginTop: 32 }}
        />
        <Text style={styles.animatingTitle}>Animating your twin...</Text>
        <Text style={styles.animatingText}>
          {progress < 40
            ? "Uploading photo..."
            : progress < 70
              ? "Generating animation..."
              : progress < 90
                ? "Bringing it to life..."
                : "Almost there! ✨"}
        </Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{progress}%</Text>
      </SafeAreaView>
    );
  }

  // ── Step: Done ───────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={[styles.root, styles.center]}>
      <View style={styles.doneRing}>
        <Image source={{ uri: imageUri! }} style={styles.doneImage} />
      </View>
      <Text style={styles.doneEmoji}>🎉</Text>
      <Text style={styles.doneTitle}>Meet {avatarName}!</Text>
      <Text style={styles.doneSub}>Hi! I'm ready to chat with you 👋</Text>
      <TouchableOpacity
        style={styles.chatButton}
        onPress={handleDone}
        activeOpacity={0.88}
      >
        <Text style={styles.chatButtonText}>Go to Home</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: 24,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  closeButton: {
    marginTop: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  closeText: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: "600",
  },
  heroSection: {
    alignItems: "center",
    paddingTop: height * 0.06,
    paddingBottom: 40,
  },
  heroEmoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  heroTitle: {
    fontSize: 34,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
    lineHeight: 40,
  },
  heroSub: {
    color: Colors.textSecondary,
    fontSize: 15,
    marginTop: 10,
  },
  optionsContainer: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 24,
  },
  optionCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 20,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  optionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.surfaceHigh,
    alignItems: "center",
    justifyContent: "center",
  },
  optionEmoji: {
    fontSize: 26,
  },
  optionTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  optionSub: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: "center",
  },
  tipBox: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tipText: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  previewTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.text,
    marginTop: 24,
    textAlign: "center",
  },
  previewSub: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 24,
  },
  previewImageWrap: {
    alignItems: "center",
    marginBottom: 24,
  },
  previewImage: {
    width: width * 0.65,
    height: width * 0.65,
    borderRadius: (width * 0.65) / 2,
    borderWidth: 4,
    borderColor: Colors.primary,
  },
  retakeButton: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  retakeText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  nameField: {
    marginBottom: 24,
  },
  nameLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  nameInput: {
    backgroundColor: Colors.surface,
    color: Colors.text,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  animateButton: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 8,
  },
  animateButtonDisabled: {
    opacity: 0.45,
  },
  animateButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
  animatingImage: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 3,
    borderColor: Colors.primary,
    opacity: 0.8,
  },
  animatingTitle: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: "700",
    marginTop: 20,
  },
  animatingText: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
  },
  progressBar: {
    width: width * 0.65,
    height: 6,
    backgroundColor: Colors.surfaceHigh,
    borderRadius: 3,
    overflow: "hidden",
    marginTop: 24,
  },
  progressFill: {
    height: "100%",
    backgroundColor: Colors.primary,
    borderRadius: 3,
  },
  progressLabel: {
    color: Colors.textMuted,
    fontSize: 13,
    marginTop: 8,
  },
  doneRing: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 4,
    borderColor: Colors.primary,
    overflow: "hidden",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  doneImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  doneEmoji: {
    fontSize: 52,
    marginTop: 20,
  },
  doneTitle: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: "800",
    marginTop: 10,
  },
  doneSub: {
    color: Colors.textSecondary,
    fontSize: 15,
    marginTop: 8,
    marginBottom: 32,
  },
  chatButton: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 48,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 8,
  },
  chatButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
});
