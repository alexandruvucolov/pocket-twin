import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Platform } from "react-native";
import * as NavigationBar from "expo-navigation-bar";
import { AuthProvider } from "../src/context/AuthContext";
import { AvatarProvider } from "../src/context/AvatarContext";
import { Colors } from "../src/constants/colors";

export default function RootLayout() {
  useEffect(() => {
    if (Platform.OS === "android") {
      // setBackgroundColorAsync not supported with edge-to-edge; bar is transparent,
      // app background (#0D0D1A) shows through automatically.
      NavigationBar.setButtonStyleAsync("light");
    }
  }, []);

  return (
    <AuthProvider>
      <AvatarProvider>
        <StatusBar style="light" backgroundColor={Colors.background} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Colors.background },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="upload"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="buy-coins"
            options={{ presentation: "modal", animation: "slide_from_bottom" }}
          />
        </Stack>
      </AvatarProvider>
    </AuthProvider>
  );
}
