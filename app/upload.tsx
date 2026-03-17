import React, { useRef, useState } from "react";
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
  Platform,
  Keyboard,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { CameraView } from "expo-camera";
import { useRouter } from "expo-router";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useAvatars } from "@/context/AvatarContext";
import { useAuth } from "@/context/AuthContext";
import {
  firebaseEnabled,
  getFirebaseErrorMessage,
  uploadAvatarImage,
} from "@/lib/firebase";
import {
  createLivePortraitVideo,
  getDefaultLivePortraitDrivingVideoUrl,
  isLivePortraitConfigured,
} from "@/lib/liveportrait";
import { useVideoPlayer, VideoView } from "expo-video";

const { width, height } = Dimensions.get("window");

type Step = "pick" | "camera" | "preview" | "animating" | "done";

export default function UploadScreen() {
  const router = useRouter();
  const { addAvatar } = useAvatars();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>("pick");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [avatarName, setAvatarName] = useState("");
  const [progress, setProgress] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"front" | "back">("front");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const cameraRef = useRef<CameraView | null>(null);

  const videoPlayer = useVideoPlayer(null, (player) => {
    player.loop = true;
  });

  // Update player source when D-ID resolves
  React.useEffect(() => {
    if (videoUrl) {
      videoPlayer.replace(videoUrl);
      videoPlayer.play();
    }
  }, [videoUrl]);

  React.useEffect(() => {
    if (Platform.OS !== "android") return;

    const showSub = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });

    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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
    setStep("camera");
  };

  const captureSelfie = async () => {
    if (!cameraRef.current || isCapturing) return;

    setIsCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
        mirror: false,
      });

      if (!photo?.uri) {
        Alert.alert(
          "Capture failed",
          "Could not take photo. Please try again.",
        );
        return;
      }

      setImageUri(photo.uri);
      setStep("preview");
    } catch {
      Alert.alert("Camera error", "Could not access camera. Please try again.");
    } finally {
      setIsCapturing(false);
    }
  };

  const handleAnimate = async () => {
    if (!avatarName.trim()) {
      Alert.alert("Name required", "Give your avatar a name first!");
      return;
    }
    if (!imageUri) return;

    setStep("animating");
    setProgress(0);

    try {
      const avatarId = Date.now().toString();
      let finalImageUri = imageUri;

      setProgress(15);
      await new Promise((r) => setTimeout(r, 250));

      if (firebaseEnabled && user) {
        setProgress(35);
        finalImageUri = await uploadAvatarImage({
          userId: user.id,
          avatarId,
          localUri: imageUri,
        });
      }

      setProgress(50);

      let resultVideoUrl: string | undefined;

      if (
        isLivePortraitConfigured() &&
        firebaseEnabled &&
        user &&
        /^https?:\/\//i.test(finalImageUri) &&
        getDefaultLivePortraitDrivingVideoUrl()
      ) {
        resultVideoUrl = await createLivePortraitVideo({
          sourceImageUrl: finalImageUri,
          onStatus: (message) => {
            if (message.includes("Submitting")) {
              setProgress(58);
              return;
            }

            if (message.includes("in_queue")) {
              setProgress(66);
              return;
            }

            if (message.includes("in_progress")) {
              setProgress(82);
              return;
            }

            if (message.includes("completed")) {
              setProgress(96);
            }
          },
        });
      } else {
        for (const p of [65, 80, 100]) {
          await new Promise((r) => setTimeout(r, 200));
          setProgress(p);
        }
      }

      setProgress(100);

      setVideoUrl(resultVideoUrl ?? null);

      addAvatar({
        id: avatarId,
        name: avatarName.trim(),
        imageUri: finalImageUri,
        videoUrl: resultVideoUrl,
        createdAt: new Date(),
        messageCount: 0,
      });

      setStep("done");
    } catch (error) {
      Alert.alert(
        "Upload failed",
        getFirebaseErrorMessage(
          error,
          "Could not upload avatar image. Please try again.",
        ),
      );
      setStep("preview");
      setProgress(0);
    }
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
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
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

  if (step === "camera") {
    return (
      <SafeAreaView style={styles.cameraRoot} edges={["top", "bottom"]}>
        <CameraView
          ref={cameraRef}
          style={styles.cameraView}
          facing={cameraFacing}
          mirror={false}
        />

        <View style={styles.cameraGuideLayer} pointerEvents="none">
          <View style={styles.cameraGuideSquare} />
          <Text style={styles.cameraGuideText}>
            Center your face in the frame
          </Text>
        </View>

        <View style={styles.cameraOverlay}>
          <View style={styles.cameraTopRow}>
            <TouchableOpacity
              style={styles.cameraBackButton}
              onPress={() => setStep("pick")}
            >
              <Ionicons name="chevron-back" size={22} color={Colors.text} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cameraSwitchButton}
              onPress={() =>
                setCameraFacing((prev) => (prev === "front" ? "back" : "front"))
              }
              activeOpacity={0.8}
            >
              <Ionicons
                name="camera-reverse-outline"
                size={20}
                color={Colors.text}
              />
            </TouchableOpacity>
          </View>

          <View
            style={[
              styles.cameraBottomBar,
              { marginBottom: Math.max(18, insets.bottom + 16) },
            ]}
          >
            <TouchableOpacity
              style={styles.captureButtonOuter}
              onPress={captureSelfie}
              disabled={isCapturing}
              activeOpacity={0.85}
            >
              <View style={styles.captureButtonInner} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Step: Preview ────────────────────────────────────────────────────────
  if (step === "preview") {
    const previewTranslateY =
      Platform.OS === "android" && keyboardHeight > 0
        ? -Math.max(0, keyboardHeight - 120)
        : 0;

    return (
      <SafeAreaView style={styles.root}>
        <View
          style={[
            styles.previewScreen,
            { transform: [{ translateY: previewTranslateY }] },
          ]}
        >
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => setStep("pick")}
          >
            <Ionicons name="chevron-back" size={22} color={Colors.text} />
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

          <View style={styles.previewFormWrap}>
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
          </View>
        </View>
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
          {progress < 35
            ? "Uploading photo..."
            : progress < 52
              ? "Preparing animation..."
              : progress < 90
                ? "Generating animation..."
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
        {videoUrl ? (
          <VideoView
            player={videoPlayer}
            style={styles.doneImage}
            contentFit="cover"
            nativeControls={false}
          />
        ) : (
          <Image source={{ uri: imageUri! }} style={styles.doneImage} />
        )}
      </View>
      <Text style={styles.doneEmoji}>🎉</Text>
      <Text style={styles.doneTitle}>Meet {avatarName}!</Text>
      <Text style={styles.doneSub}>
        {videoUrl
          ? "Watch your twin come to life! 🎬"
          : "I'm ready to chat with you 👋"}
      </Text>
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
  cameraRoot: {
    flex: 1,
    backgroundColor: "#000",
  },
  cameraView: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  cameraGuideLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraGuideSquare: {
    width: width * 0.68,
    height: width * 0.68,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.95)",
    backgroundColor: "transparent",
  },
  cameraGuideText: {
    marginTop: 14,
    color: "rgba(255,255,255,0.92)",
    fontSize: 13,
    fontWeight: "600",
    backgroundColor: "rgba(0,0,0,0.35)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  cameraBackButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraTopRow: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cameraSwitchButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraBottomBar: {
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  captureButtonOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: Colors.white,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  captureButtonInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: Colors.white,
  },
  root: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: 24,
  },
  previewScreen: {
    flex: 1,
  },
  previewFormWrap: {
    marginTop: 8,
    paddingBottom: 12,
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
    marginBottom: 12,
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
