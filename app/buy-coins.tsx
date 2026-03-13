import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Dimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";
import { useAvatars } from "@/context/AvatarContext";
import { COIN_PACKS } from "@/constants/dummy";

const { width } = Dimensions.get("window");

export default function BuyCoinsScreen() {
  const router = useRouter();
  const { coins, addCoins } = useAvatars();
  const [selectedPack, setSelectedPack] = useState<string | null>("coins_50");
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);

  const handleFreeClaim = async () => {
    setIsClaiming(true);
    await new Promise((r) => setTimeout(r, 600));
    addCoins(20);
    setIsClaiming(false);
    Alert.alert("🎁 Claimed!", "20 free coins added to your balance!", [
      { text: "Nice!", onPress: () => router.back() },
    ]);
  };

  const handlePurchase = async () => {
    if (!selectedPack) return;
    const pack = COIN_PACKS.find((p) => p.id === selectedPack);
    if (!pack) return;

    setIsPurchasing(true);
    // Simulate RevenueCat purchase flow
    await new Promise((r) => setTimeout(r, 1500));
    setIsPurchasing(false);

    const totalCoins = pack.coins + pack.bonus;
    addCoins(totalCoins);

    Alert.alert(
      "🎉 Payment Successful!",
      `You received ${pack.coins} coins${pack.bonus > 0 ? ` + ${pack.bonus} bonus coins` : ""}!\nNew balance: ${coins + totalCoins} 🪙`,
      [{ text: "Let's go!", onPress: () => router.back() }],
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={() => router.back()}
        >
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Buy Coins</Text>
        <View style={styles.balanceBadge}>
          <Text style={styles.balanceText}>🪙 {coins}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Free claim banner */}
        <TouchableOpacity
          style={styles.freeClaimBanner}
          onPress={handleFreeClaim}
          activeOpacity={0.85}
          disabled={isClaiming}
        >
          {isClaiming ? (
            <ActivityIndicator color={Colors.white} size="small" />
          ) : (
            <>
              <Text style={styles.freeClaimEmoji}>🎁</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.freeClaimTitle}>Claim 20 Free Coins</Text>
                <Text style={styles.freeClaimSub}>
                  Tap to add to your balance instantly
                </Text>
              </View>
              <Text style={styles.freeClaimArrow}>›</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.heroEmoji}>🪙</Text>
          <Text style={styles.heroTitle}>Power Up Your Chats</Text>
          <Text style={styles.heroSub}>
            1 coin = 1 minute of live conversation
          </Text>
        </View>

        {/* Packs */}
        <Text style={styles.sectionLabel}>Choose a Pack</Text>
        <View style={styles.packs}>
          {COIN_PACKS.map((pack) => {
            const isSelected = selectedPack === pack.id;
            return (
              <TouchableOpacity
                key={pack.id}
                style={[styles.packCard, isSelected && styles.packCardSelected]}
                onPress={() => setSelectedPack(pack.id)}
                activeOpacity={0.85}
              >
                {pack.popular && (
                  <View style={styles.popularBadge}>
                    <Text style={styles.popularText}>⭐ BEST VALUE</Text>
                  </View>
                )}
                <View style={styles.packHeader}>
                  <View style={styles.packLeft}>
                    <View
                      style={[styles.radio, isSelected && styles.radioSelected]}
                    />
                    <Text style={styles.packLabel}>{pack.label}</Text>
                    {pack.bonus > 0 && (
                      <View style={styles.bonusBadge}>
                        <Text style={styles.bonusText}>+{pack.bonus} free</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.packPrice}>{pack.price}</Text>
                </View>
                <View style={styles.packDetails}>
                  <Text style={styles.packDetail}>
                    {pack.coins + pack.bonus} coins total
                    {pack.bonus > 0 ? ` (${pack.bonus} bonus!)` : ""}
                  </Text>
                  <Text style={styles.packDetail}>
                    ≈ {pack.coins + pack.bonus} min of chat
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* First-time bonus */}
        <View style={styles.bonusBox}>
          <Text style={styles.bonusBoxEmoji}>🎁</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.bonusBoxTitle}>First Purchase Bonus</Text>
            <Text style={styles.bonusBoxSub}>
              Get +5 extra coins on your first buy!
            </Text>
          </View>
        </View>

        {/* Pricing breakdown */}
        <View style={styles.breakdownCard}>
          <Text style={styles.breakdownTitle}>How it works</Text>
          <View style={styles.breakdownRow}>
            <Text style={styles.breakdownLabel}>💬 1 coin</Text>
            <Text style={styles.breakdownValue}>= 1 minute of chat</Text>
          </View>
          <View style={styles.breakdownRow}>
            <Text style={styles.breakdownLabel}>🔄 Unused coins</Text>
            <Text style={styles.breakdownValue}>Never expire</Text>
          </View>
          <View style={styles.breakdownRow}>
            <Text style={styles.breakdownLabel}>📱 Platform</Text>
            <Text style={styles.breakdownValue}>Apple / Google Pay</Text>
          </View>
        </View>

        {/* Buy button */}
        <TouchableOpacity
          style={[
            styles.buyButton,
            (!selectedPack || isPurchasing) && styles.buyButtonDisabled,
          ]}
          onPress={handlePurchase}
          disabled={!selectedPack || isPurchasing}
          activeOpacity={0.88}
        >
          {isPurchasing ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <Text style={styles.buyButtonText}>
                {selectedPack
                  ? `Buy ${COIN_PACKS.find((p) => p.id === selectedPack)?.label} — ${COIN_PACKS.find((p) => p.id === selectedPack)?.price}`
                  : "Select a Pack"}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <Text style={styles.legal}>
          Payments processed by Apple / Google. Subscriptions renew
          automatically. Cancel anytime in your device settings.
        </Text>
      </ScrollView>
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
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 12,
  },
  closeText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  title: {
    flex: 1,
    color: Colors.text,
    fontSize: 20,
    fontWeight: "800",
  },
  balanceBadge: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  balanceText: {
    color: Colors.gold,
    fontWeight: "700",
    fontSize: 14,
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  hero: {
    alignItems: "center",
    paddingVertical: 28,
  },
  heroEmoji: {
    fontSize: 56,
    marginBottom: 12,
  },
  heroTitle: {
    color: Colors.text,
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  heroSub: {
    color: Colors.textSecondary,
    fontSize: 14,
    marginTop: 6,
    textAlign: "center",
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 12,
    marginLeft: 2,
  },
  packs: {
    gap: 12,
    marginBottom: 20,
  },
  packCard: {
    backgroundColor: Colors.surface,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1.5,
    borderColor: Colors.border,
    position: "relative",
    overflow: "hidden",
  },
  packCardSelected: {
    borderColor: Colors.primary,
    backgroundColor: "rgba(108,71,255,0.1)",
  },
  popularBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderBottomLeftRadius: 12,
  },
  popularText: {
    color: Colors.white,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  packHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  packLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.textMuted,
  },
  radioSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary,
  },
  packLabel: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  bonusBadge: {
    backgroundColor: Colors.success,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  bonusText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: "700",
  },
  packPrice: {
    color: Colors.text,
    fontSize: 20,
    fontWeight: "800",
  },
  packDetails: {
    flexDirection: "row",
    gap: 12,
  },
  packDetail: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  bonusBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(76,175,130,0.1)",
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.success,
    gap: 12,
  },
  bonusBoxEmoji: {
    fontSize: 26,
  },
  bonusBoxTitle: {
    color: Colors.success,
    fontSize: 14,
    fontWeight: "700",
  },
  bonusBoxSub: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  breakdownCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  breakdownTitle: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4,
  },
  breakdownRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  breakdownLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  breakdownValue: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  buyButton: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 8,
    marginBottom: 16,
  },
  buyButtonDisabled: {
    opacity: 0.5,
  },
  buyButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: "700",
  },
  legal: {
    color: Colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
  },
  freeClaimBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(76,175,130,0.18)",
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
    marginBottom: 4,
    borderWidth: 1.5,
    borderColor: Colors.success,
    gap: 12,
  },
  freeClaimEmoji: { fontSize: 28 },
  freeClaimTitle: {
    color: Colors.success,
    fontSize: 15,
    fontWeight: "800",
  },
  freeClaimSub: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  freeClaimArrow: {
    color: Colors.success,
    fontSize: 26,
    fontWeight: "300",
  },
});
