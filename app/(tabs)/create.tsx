import React, { useState, useRef } from "react";
import { useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
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
  Modal,
  StatusBar,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import * as Clipboard from "expo-clipboard";
import * as VideoThumbnails from "expo-video-thumbnails";
import { File, Paths } from "expo-file-system";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { COIN_COSTS } from "@/constants/dummy";
import { useAvatars } from "@/context/AvatarContext";
import {
  runCreateJob,
  CreateJobStatus,
  isCreateConfigured,
} from "@/lib/create-serverless";
import { enhancePrompt } from "@/lib/openai";

const { width } = Dimensions.get("window");

function VideoPlayerResult({
  uri,
  style,
  contentFit = "cover",
}: {
  uri: string;
  style: any;
  contentFit?: "cover" | "contain" | "fill";
}) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={style}
      contentFit={contentFit}
      nativeControls
    />
  );
}

type Mode = "image" | "video";
type VideoSource = "text" | "image";
type VideoFormat = "landscape" | "portrait" | "square";

// FLUX-specific trigger words for each style chip — appended after GPT enhancement
// so GPT cannot dilute or overwrite the style.
const STYLE_PROMPT_SUFFIX: Record<string, string> = {
  Photorealistic:
    "photorealistic, hyperrealistic, 8K UHD, DSLR photograph, sharp focus, natural skin texture, high detail",
  Anime:
    "anime style, cel shading, manga illustration, vibrant saturated colors, Studio Ghibli aesthetic, detailed line art, 2D animation",
  Cinematic:
    "cinematic photography, movie still, dramatic lighting, anamorphic lens bokeh, film grain, widescreen composition, Hollywood color grade",
  "Oil Painting":
    "oil painting on canvas, impasto technique, visible brushstrokes, textured canvas, classical fine art, rich deep colors, old masters style",
  "3D Render":
    "3D CGI render, Blender octane render, ray tracing, subsurface scattering, physically based rendering, ultra-detailed 3D, ambient occlusion",
};

const VIDEO_FORMAT_SIZES: Record<
  VideoFormat,
  { width: number; height: number; label: string }
> = {
  portrait: { width: 480, height: 832, label: "Portrait" },
  landscape: { width: 832, height: 480, label: "Landscape" },
  square: { width: 624, height: 624, label: "Square" },
};

export default function CreateScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { coins, spendCoins } = useAvatars();
  const [mode, setMode] = useState<Mode>("image");
  const [videoSource, setVideoSource] = useState<VideoSource>("text");
  const [prompt, setPrompt] = useState("");
  const [selectedDuration, setSelectedDuration] = useState<
    "5s" | "10s" | "15s"
  >("5s");
  const [selectedVideoFormat, setSelectedVideoFormat] =
    useState<VideoFormat>("portrait");
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<{
    uri: string;
    base64: string;
  } | null>(null);
  const [jobStatus, setJobStatus] = useState<CreateJobStatus | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [savedItems, setSavedItems] = useState<
    { uri: string; type: "image" | "video"; thumbnail?: string }[]
  >([]);
  const [savedMessage, setSavedMessage] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lightboxItem, setLightboxItem] = useState<{
    uri: string;
    type: "image" | "video";
  } | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const generating =
    jobStatus !== null &&
    jobStatus.phase !== "done" &&
    jobStatus.phase !== "error";

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission required",
        "Allow access to your photo library to pick an image.",
      );
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.85,
      base64: true,
    });
    if (!picked.canceled && picked.assets[0]) {
      const asset = picked.assets[0];
      setReferenceImage({ uri: asset.uri, base64: asset.base64 ?? "" });
    }
  };

  const handleSave = async () => {
    if (!result || isSaving || savedMessage) return;
    setIsSaving(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission required",
          "Allow access to your photo library to save.",
        );
        return;
      }
      let localUri: string;
      if (result.startsWith("data:image/")) {
        const b64 = result.replace(/^data:image\/\w+;base64,/, "");
        const cacheFile = new File(
          Paths.cache,
          `pocket-twin-${Date.now()}.png`,
        );
        await cacheFile.write(b64, { encoding: "base64" });
        localUri = cacheFile.uri;
      } else {
        const downloaded = await File.downloadFileAsync(result, Paths.cache);
        localUri = downloaded.uri;
      }
      await MediaLibrary.saveToLibraryAsync(localUri);
      // Add to gallery thumbnails
      if (mode === "video") {
        let thumbnail: string | undefined;
        try {
          const t = await VideoThumbnails.getThumbnailAsync(result, {
            time: 0,
          });
          thumbnail = t.uri;
        } catch (_) {}
        setSavedItems((prev) => [
          { uri: result, type: "video", thumbnail },
          ...prev,
        ]);
      } else {
        setSavedItems((prev) => [{ uri: result, type: "image" }, ...prev]);
      }
      // Show banner in the result card, then dismiss after 2s
      setIsSaving(false);
      setSavedMessage(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedMessage(false);
        setResult(null);
        setJobStatus(null);
      }, 2000);
    } catch (e: any) {
      setIsSaving(false);
      Alert.alert("Save failed", e.message);
    }
  };

  const handleShare = async () => {
    if (!result) return;
    try {
      let localUri: string;
      if (result.startsWith("data:image/")) {
        const b64 = result.replace(/^data:image\/\w+;base64,/, "");
        const cacheFile = new File(
          Paths.cache,
          `pocket-twin-share-${Date.now()}.png`,
        );
        await cacheFile.write(b64, { encoding: "base64" });
        localUri = cacheFile.uri;
      } else {
        const downloaded = await File.downloadFileAsync(result, Paths.cache);
        localUri = downloaded.uri;
      }
      await Sharing.shareAsync(localUri, {
        mimeType: mode === "video" ? "video/mp4" : "image/png",
        dialogTitle: "Share your creation",
      });
    } catch (e: any) {
      if (!e.message?.includes("cancelled")) {
        Alert.alert("Share failed", e.message);
      }
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    if (generating) return; // guard against double-tap
    if (!isCreateConfigured()) {
      Alert.alert(
        "Not configured",
        "EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID is not set.",
      );
      return;
    }

    // Cancel any in-flight request before starting a new one
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    // Calculate coin cost for this generation
    let cost = 0;
    if (mode === "image") {
      cost = referenceImage ? COIN_COSTS.imageToImage : COIN_COSTS.textToImage;
    } else if (videoSource === "text") {
      cost = selectedDuration === "15s" ? COIN_COSTS.t2v_15s
           : selectedDuration === "10s" ? COIN_COSTS.t2v_10s
           : COIN_COSTS.t2v_5s;
    } else {
      cost = selectedDuration === "10s" ? COIN_COSTS.i2v_10s : COIN_COSTS.i2v_5s;
    }

    if (coins < cost) {
      Alert.alert(
        "Not enough coins",
        `This generation costs ${cost} 🪙 but you only have ${coins}. Buy more coins to continue.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Buy Coins", onPress: () => router.push("/buy-coins") },
        ],
      );
      return;
    }

    setResult(null);
    setJobStatus({ phase: "queued", progress: 0 });

    // Pass the raw prompt to GPT (no style tag — GPT is unreliable at preserving style).
    // We append FLUX-specific style keywords deterministically after enhancement.
    const rawPrompt = prompt.trim();

    try {
      // Enhance the prompt with GPT-4o-mini before sending to the model
      let enhanced = rawPrompt;
      try {
        enhanced = await enhancePrompt(rawPrompt, mode);
      } catch (_) {
        // If enhancement fails, fall back to original prompt silently
      }

      // Append FLUX style trigger words after GPT enhancement so they cannot be overwritten
      if (
        selectedStyle &&
        mode === "image" &&
        STYLE_PROMPT_SUFFIX[selectedStyle]
      ) {
        enhanced = `${enhanced}, ${STYLE_PROMPT_SUFFIX[selectedStyle]}`;
      }

      const input =
        mode === "image"
          ? referenceImage
            ? {
                task: "image_to_image" as const,
                prompt: enhanced,
                image: referenceImage.base64,
                num_inference_steps: 20,
                strength: 0.9,
              }
            : {
                task: "text_to_image" as const,
                prompt: enhanced,
                width: 768,
                height: 1024,
                num_inference_steps: 4,
              }
          : videoSource === "text"
            ? {
                task: "text_to_video" as const,
                prompt: enhanced,
                duration: selectedDuration,
                width: VIDEO_FORMAT_SIZES[selectedVideoFormat].width,
                height: VIDEO_FORMAT_SIZES[selectedVideoFormat].height,
                num_inference_steps: 20,
              }
            : {
                task: "image_to_video" as const,
                prompt: enhanced,
                image: referenceImage?.base64 ?? "",
                imageUri: referenceImage?.uri,
                duration: (selectedDuration === "15s"
                  ? "5s"
                  : selectedDuration) as "5s" | "10s",
                width: VIDEO_FORMAT_SIZES[selectedVideoFormat].width,
                height: VIDEO_FORMAT_SIZES[selectedVideoFormat].height,
                num_inference_steps: 20,
              };

      const url = await runCreateJob(
        input,
        (s) => setJobStatus(s),
        abortRef.current.signal,
      );
      spendCoins(cost);
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
          <Text style={styles.coinCount}>{coins}</Text>
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
            onPress={() => {
              setMode("image");
              setPrompt("");
              setReferenceImage(null);
              setSelectedStyle(null);
              setSelectedVideoFormat("portrait");
              setResult(null);
              setJobStatus(null);
            }}
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
            onPress={() => {
              setMode("video");
              setPrompt("");
              setReferenceImage(null);
              setSelectedStyle(null);
              setSelectedVideoFormat("portrait");
              setResult(null);
              setJobStatus(null);
            }}
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
              onPress={() => {
                setVideoSource("image");
                // 15s is PixVerse T2V only — reset to 5s for Kling I2V
                if (selectedDuration === "15s") setSelectedDuration("5s");
              }}
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
            <TouchableOpacity
              style={styles.imagePicker}
              onPress={handlePickImage}
            >
              {referenceImage ? (
                <View style={StyleSheet.absoluteFill}>
                  <Image
                    source={{ uri: referenceImage.uri }}
                    style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
                    resizeMode="cover"
                  />
                  <TouchableOpacity
                    style={styles.imagePickerClear}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      setReferenceImage(null);
                    }}
                  >
                    <Ionicons
                      name="close-circle"
                      size={26}
                      color={Colors.white}
                    />
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <Ionicons name="add" size={32} color={Colors.textMuted} />
                  <Text style={styles.imagePickerText}>Tap to upload</Text>
                </>
              )}
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
              {(videoSource === "text"
                ? (["5s", "10s", "15s"] as const)
                : (["5s", "10s"] as const)
              ).map((d) => (
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

        {/* Format picker (video only) */}
        {mode === "video" && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Format</Text>
            <View style={styles.chipRow}>
              {(Object.keys(VIDEO_FORMAT_SIZES) as VideoFormat[]).map((f) => (
                <TouchableOpacity
                  key={f}
                  style={[
                    styles.chip,
                    selectedVideoFormat === f && styles.chipActive,
                  ]}
                  onPress={() => setSelectedVideoFormat(f)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedVideoFormat === f && styles.chipTextActive,
                    ]}
                  >
                    {VIDEO_FORMAT_SIZES[f].label}
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
            {mode === "image"
              ? `${referenceImage ? COIN_COSTS.imageToImage : COIN_COSTS.textToImage} coin per image`
              : videoSource === "text"
                ? `${ selectedDuration === "15s" ? COIN_COSTS.t2v_15s : selectedDuration === "10s" ? COIN_COSTS.t2v_10s : COIN_COSTS.t2v_5s } coins (${selectedDuration} T2V)`
                : `${ selectedDuration === "10s" ? COIN_COSTS.i2v_10s : COIN_COSTS.i2v_5s } coins (${selectedDuration} I2V)`}
          </Text>
        </View>

        {/* Generate button */}
        <TouchableOpacity
          style={[
            styles.generateBtn,
            (!prompt.trim() ||
              generating ||
              (mode === "video" &&
                videoSource === "image" &&
                !referenceImage)) &&
              styles.generateBtnDisabled,
          ]}
          onPress={handleGenerate}
          disabled={
            !prompt.trim() ||
            generating ||
            (mode === "video" && videoSource === "image" && !referenceImage)
          }
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
              {mode === "image"
                ? "Generating image\u2026"
                : `Rendering video\u2026 ${jobStatus.progress ?? 0}%`}
            </Text>
            <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {result && !generating && (
          <View style={styles.resultCard}>
            {mode === "video" ? (
              <VideoPlayerResult uri={result} style={styles.resultImage} />
            ) : (
              <Image
                source={{ uri: result }}
                style={styles.resultImage}
                resizeMode="cover"
              />
            )}
            {savedMessage && (
              <View style={styles.savedBanner}>
                <Ionicons name="checkmark-circle" size={20} color="#4ADE80" />
                <Text style={styles.savedBannerText}>
                  {mode === "video"
                    ? "Video saved to gallery"
                    : "Picture saved to gallery"}
                </Text>
              </View>
            )}
            <View style={styles.resultActions}>
              <TouchableOpacity
                style={styles.resultBtn}
                onPress={handleSave}
                disabled={isSaving || savedMessage}
              >
                <Ionicons
                  name="download-outline"
                  size={18}
                  color={Colors.white}
                />
                <Text style={styles.resultBtnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resultBtn} onPress={handleShare}>
                <Ionicons
                  name="share-social-outline"
                  size={18}
                  color={Colors.white}
                />
                <Text style={styles.resultBtnText}>Share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.resultBtn, styles.resultBtnPrimary]}
                onPress={handleGenerate}
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

        {/* Saved gallery */}
        {savedItems.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Saved</Text>
            <View style={styles.galleryGrid}>
              {savedItems.map((item, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.galleryItem}
                  onPress={() => setLightboxItem(item)}
                  activeOpacity={0.85}
                >
                  <Image
                    source={{ uri: item.thumbnail ?? item.uri }}
                    style={styles.galleryThumb}
                    resizeMode="cover"
                  />
                  {item.type === "video" && (
                    <View style={styles.galleryVideoIcon}>
                      <Ionicons name="play" size={16} color={Colors.white} />
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.galleryDeleteBtn}
                    onPress={() =>
                      setSavedItems((prev) =>
                        prev.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Ionicons name="close-circle" size={22} color="#FF4444" />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Full-screen lightbox */}
      <Modal
        visible={lightboxItem !== null}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setLightboxItem(null)}
      >
        <View style={styles.lightboxBackdrop}>
          <TouchableOpacity
            style={styles.lightboxClose}
            onPress={() => setLightboxItem(null)}
          >
            <Ionicons name="close" size={28} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.lightboxShare}
            onPress={async () => {
              if (!lightboxItem) return;
              try {
                let localUri: string;
                if (lightboxItem.uri.startsWith("data:image/")) {
                  const b64 = lightboxItem.uri.replace(
                    /^data:image\/\w+;base64,/,
                    "",
                  );
                  const cacheFile = new File(
                    Paths.cache,
                    `pocket-twin-share-${Date.now()}.png`,
                  );
                  await cacheFile.write(b64, { encoding: "base64" });
                  localUri = cacheFile.uri;
                } else {
                  const downloaded = await File.downloadFileAsync(
                    lightboxItem.uri,
                    Paths.cache,
                  );
                  localUri = downloaded.uri;
                }
                await Sharing.shareAsync(localUri, {
                  mimeType:
                    lightboxItem.type === "video" ? "video/mp4" : "image/png",
                  dialogTitle: "Share your creation",
                });
              } catch (e: any) {
                if (!e.message?.includes("cancelled")) {
                  Alert.alert("Share failed", e.message);
                }
              }
            }}
          >
            <Ionicons name="share-outline" size={28} color={Colors.white} />
          </TouchableOpacity>
          {lightboxItem && lightboxItem.type === "image" && (
            <TouchableOpacity
              style={styles.lightboxCopy}
              onPress={async () => {
                if (!lightboxItem) return;
                try {
                  let b64: string;
                  if (lightboxItem.uri.startsWith("data:image/")) {
                    b64 = lightboxItem.uri.replace(
                      /^data:image\/\w+;base64,/,
                      "",
                    );
                  } else {
                    const downloaded = await File.downloadFileAsync(
                      lightboxItem.uri,
                      Paths.cache,
                    );
                    const bytes = await new File(downloaded.uri).bytes();
                    b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
                  }
                  await Clipboard.setImageAsync(b64);
                  Alert.alert("Copied", "Image copied to clipboard");
                } catch (e: any) {
                  Alert.alert("Copy failed", e.message);
                }
              }}
            >
              <Ionicons name="copy-outline" size={28} color={Colors.white} />
            </TouchableOpacity>
          )}
          {lightboxItem &&
            (lightboxItem.type === "video" ? (
              <VideoPlayerResult
                uri={lightboxItem.uri}
                style={styles.lightboxMedia}
                contentFit="contain"
              />
            ) : (
              <Image
                source={{ uri: lightboxItem.uri }}
                style={styles.lightboxMedia}
                resizeMode="contain"
              />
            ))}
        </View>
      </Modal>
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
    overflow: "hidden",
  },
  imagePickerText: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  imagePickerClear: {
    position: "absolute",
    top: 6,
    right: 6,
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
  // Saved gallery
  galleryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  galleryItem: {
    width: (width - 48 - 8) / 2,
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "visible",
  },
  galleryThumb: {
    width: "100%",
    height: "100%",
    borderRadius: 12,
  },
  galleryVideoIcon: {
    position: "absolute",
    bottom: 8,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 12,
    padding: 4,
  },
  galleryDeleteBtn: {
    position: "absolute",
    top: -8,
    right: -8,
    zIndex: 10,
    backgroundColor: Colors.background,
    borderRadius: 11,
  },
  // Saved banner
  savedBanner: {
    position: "absolute",
    bottom: 70,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  savedBannerText: {
    color: "#4ADE80",
    fontSize: 14,
    fontWeight: "700",
  },
  // Lightbox
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  lightboxClose: {
    position: "absolute",
    top: 52,
    right: 20,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
    padding: 6,
  },
  lightboxShare: {
    position: "absolute",
    top: 52,
    left: 20,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
    padding: 6,
  },
  lightboxCopy: {
    position: "absolute",
    top: 52,
    left: 76,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 20,
    padding: 6,
  },
  lightboxMedia: {
    width: "100%",
    flex: 1,
  },
});
