import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  Dimensions,
  ActivityIndicator,
  Alert,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import {
  runCreateJob,
  warmupCreateWorker,
  CreateJobStatus,
  isCreateConfigured,
} from "@/lib/create-serverless";

const { width } = Dimensions.get("window");

type Mode = "image" | "video";
type VideoSource = "text" | "image";

export default function CreateScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>("image");
  const [videoSource, setVideoSource] = useState<VideoSource>("text");
  const [prompt, setPrompt] = useState("");
  const [selectedDuration, setSelectedDuration] = useState<
    "6s" | "15s" | "30s"
  >("6s");
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<CreateJobStatus | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const generating =
    jobStatus !== null &&
    jobStatus.phase !== "done" &&
    jobStatus.phase !== "error";

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    if (!isCreateConfigured()) {
      Alert.alert(
        "Not configured",
        "EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID is not set.",
      );
      return;
    }

    abortRef.current = new AbortController();
    setResult(null);
    setJobStatus({ phase: "queued", progress: 0 });

    try {
      const input =
        mode === "image"
          ? {
              task: "text_to_image" as const,
              prompt,
              style: selectedStyle ?? undefined,
              num_inference_steps: 4,
            }
          : videoSource === "text"
            ? {
                task: "text_to_video" as const,
                prompt,
                duration: selectedDuration,
                num_inference_steps: 30,
              }
            : {
                task: "image_to_video" as const,
                prompt,
                image: "", // TODO: wire real base64 from picker
                duration: selectedDuration,
                num_inference_steps: 30,
              };

      const url = await runCreateJob(
        input,
        (s) => setJobStatus(s),
        abortRef.current.signal,
      );
      setResult(url);
      setJobStatus({ phase: "done", progress: 100, url });
    } catch (e: any) {
      if (e.message !== "Cancelled") {
        Alert.alert("Generation failed", e.message);
      }
      setJobStatus(null);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setJobStatus(null);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Create</Text>
        <View style={styles.coinBadge}>
          <Text style={styles.coinEmoji}>🪙</Text>
          <Text style={styles.coinCount}>120</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 58 + insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Mode toggle: Image / Video */}
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modeBtn, mode === "image" && styles.modeBtnActive]}
            onPress={() => setMode("image")}
          >
            <Ionicons
              name="image-outline"
              size={18}
              color={mode === "image" ? Colors.white : Colors.textSecondary}
            />
            <Text
              style={[
                styles.modeBtnText,
                mode === "image" && styles.modeBtnTextActive,
              ]}
            >
              Image
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeBtn, mode === "video" && styles.modeBtnActive]}
            onPress={() => setMode("video")}
          >
            <Ionicons
              name="videocam-outline"
              size={18}
              color={mode === "video" ? Colors.white : Colors.textSecondary}
            />
            <Text
              style={[
                styles.modeBtnText,
                mode === "video" && styles.modeBtnTextActive,
              ]}
            >
              Video
            </Text>
          </TouchableOpacity>
        </View>

        {/* Video sub-toggle: text-to-video / image-to-video */}
        {mode === "video" && (
          <View style={styles.subToggleRow}>
            <TouchableOpacity
              style={[
                styles.subToggleBtn,
                videoSource === "text" && styles.subToggleBtnActive,
              ]}
              onPress={() => setVideoSource("text")}
            >
              <Text
                style={[
                  styles.subToggleText,
                  videoSource === "text" && styles.subToggleTextActive,
                ]}
              >
                Text → Video
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.subToggleBtn,
                videoSource === "image" && styles.subToggleBtnActive,
              ]}
              onPress={() => setVideoSource("image")}
            >
              <Text
                style={[
                  styles.subToggleText,
                  videoSource === "image" && styles.subToggleTextActive,
                ]}
              >
                Image → Video
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Reference image picker (image mode always, video-image mode) */}
        {(mode === "image" ||
          (mode === "video" && videoSource === "image")) && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              {mode === "image" ? "Reference image (optional)" : "Source image"}
            </Text>
            <TouchableOpacity style={styles.imagePicker}>
              <Ionicons name="add" size={32} color={Colors.textMuted} />
              <Text style={styles.imagePickerText}>Tap to upload</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Prompt input */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            {mode === "image"
              ? "Describe your image"
              : videoSource === "text"
                ? "Describe your video"
                : "Describe the motion"}
          </Text>
          <TextInput
            style={styles.promptInput}
            placeholder={
              mode === "image"
                ? "A cinematic portrait of a woman in neon lights..."
                : videoSource === "text"
                  ? "A drone flying over a misty mountain at sunrise..."
                  : "Slow zoom in, soft wind moving the hair..."
            }
            placeholderTextColor={Colors.textMuted}
            value={prompt}
            onChangeText={setPrompt}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Style chips (image only) */}
        {mode === "image" && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Style</Text>
            <View style={styles.chipRow}>
              {[
                "Photorealistic",
                "Anime",
                "Cinematic",
                "Oil Painting",
                "3D Render",
              ].map((s) => (
                <TouchableOpacity
                  key={s}
                  style={[
                    styles.chip,
                    selectedStyle === s && styles.chipActive,
                  ]}
                  onPress={() =>
                    setSelectedStyle(selectedStyle === s ? null : s)
                  }
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedStyle === s && styles.chipTextActive,
                    ]}
                  >
                    {s}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Duration picker (video only) */}
        {mode === "video" && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Duration</Text>
            <View style={styles.chipRow}>
              {(["6s", "15s", "30s"] as const).map((d) => (
                <TouchableOpacity
                  key={d}
                  style={[
                    styles.chip,
                    selectedDuration === d && styles.chipActive,
                  ]}
                  onPress={() => setSelectedDuration(d)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedDuration === d && styles.chipTextActive,
                    ]}
                  >
                    {d}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Cost hint */}
        <View style={styles.costRow}>
          <Ionicons
            name="information-circle-outline"
            size={14}
            color={Colors.textMuted}
          />
          <Text style={styles.costText}>
            {mode === "image" ? "~2 coins per image" : "~15 coins per video"}
          </Text>
        </View>

        {/* Generate button */}
        <TouchableOpacity
          style={[
            styles.generateBtn,
            (!prompt.trim() || generating) && styles.generateBtnDisabled,
          ]}
          onPress={handleGenerate}
          disabled={!prompt.trim() || generating}
          activeOpacity={0.85}
        >
          {generating ? (
            <ActivityIndicator color={Colors.white} size="small" />
          ) : (
            <>
              <Ionicons name="sparkles" size={18} color={Colors.white} />
              <Text style={styles.generateBtnText}>
                Generate {mode === "image" ? "Image" : "Video"}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {/* Progress status */}
        {generating && jobStatus && (
          <View style={styles.resultPlaceholder}>
            <ActivityIndicator color={Colors.primary} size="large" />
            <Text style={styles.resultPlaceholderText}>
              {jobStatus.phase === "queued"
                ? "Waiting for worker\u2026"
                : mode === "image"
                  ? "Generating image\u2026"
                  : `Rendering video\u2026 ${jobStatus.progress ?? 0}%`}
            </Text>
            {jobStatus.phase === "queued" && (
              <Text style={styles.warmupHint}>
                First job wakes the worker (~1\u20132 min) \u2615
              </Text>
            )}
            <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {result && !generating && (
          <View style={styles.resultCard}>
            <Image
              source={{ uri: result }}
              style={styles.resultImage}
              resizeMode="cover"
            />
            <View style={styles.resultActions}>
              <TouchableOpacity style={styles.resultBtn}>
                <Ionicons
                  name="download-outline"
                  size={18}
                  color={Colors.white}
                />
                <Text style={styles.resultBtnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resultBtn}>
                <Ionicons
                  name="share-social-outline"
                  size={18}
                  color={Colors.white}
                />
                <Text style={styles.resultBtnText}>Share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.resultBtn, styles.resultBtnPrimary]}
              >
                <Ionicons
                  name="refresh-outline"
                  size={18}
                  color={Colors.white}
                />
                <Text style={styles.resultBtnText}>Regenerate</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    color: Colors.white,
    fontSize: 28,
    fontWeight: "800",
  },
  coinBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 5,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  coinEmoji: { fontSize: 14 },
  coinCount: {
    color: Colors.gold,
    fontWeight: "700",
    fontSize: 14,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  // Mode toggle
  modeRow: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 4,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  modeBtnActive: {
    backgroundColor: Colors.primary,
  },
  modeBtnText: {
    color: Colors.textSecondary,
    fontWeight: "600",
    fontSize: 15,
  },
  modeBtnTextActive: {
    color: Colors.white,
  },
  // Sub toggle
  subToggleRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  subToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  subToggleBtnActive: {
    borderColor: Colors.primary,
    backgroundColor: "rgba(108,71,255,0.15)",
  },
  subToggleText: {
    color: Colors.textSecondary,
    fontWeight: "600",
    fontSize: 13,
  },
  subToggleTextActive: {
    color: Colors.primaryLight,
  },
  // Sections
  section: {
    marginBottom: 20,
  },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  imagePicker: {
    height: 120,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
    gap: 6,
  },
  imagePickerText: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  promptInput: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.white,
    fontSize: 15,
    padding: 14,
    minHeight: 100,
  },
  // Chips
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: {
    backgroundColor: "rgba(108,71,255,0.18)",
    borderColor: Colors.primary,
  },
  chipText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
  },
  chipTextActive: {
    color: Colors.primaryLight,
    fontWeight: "700",
  },
  warmupHint: {
    color: Colors.textMuted,
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
  },
  cancelBtn: {
    marginTop: 14,
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  cancelBtnText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  // Cost
  costRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginBottom: 20,
  },
  costText: {
    color: Colors.textMuted,
    fontSize: 12,
  },
  // Generate button
  generateBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 24,
  },
  generateBtnDisabled: {
    opacity: 0.45,
  },
  generateBtnText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
  // Result
  resultPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingVertical: 40,
    backgroundColor: Colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  resultPlaceholderText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  resultCard: {
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  resultImage: {
    width: "100%",
    height: width - 48,
  },
  resultActions: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  resultBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.surfaceHigh,
  },
  resultBtnPrimary: {
    backgroundColor: Colors.primary,
  },
  resultBtnText: {
    color: Colors.white,
    fontSize: 13,
    fontWeight: "600",
  },
});
