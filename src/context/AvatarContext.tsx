import React, { createContext, useContext, useState, ReactNode } from "react";
import { Avatar, DUMMY_AVATARS, DUMMY_MESSAGES } from "../constants/dummy";

interface Message {
  role: "user" | "avatar";
  text: string;
}

interface AvatarContextType {
  avatars: Avatar[];
  coins: number;
  messages: Record<string, Message[]>;
  addAvatar: (avatar: Avatar) => void;
  removeAvatar: (id: string) => void;
  addMessage: (avatarId: string, msg: Message) => void;
  addCoins: (amount: number) => void;
  spendCoin: () => boolean;
  sendMessage: (avatarId: string, text: string) => Promise<void>;
}

const AvatarContext = createContext<AvatarContextType | undefined>(undefined);

export function AvatarProvider({ children }: { children: ReactNode }) {
  const [avatars, setAvatars] = useState<Avatar[]>(DUMMY_AVATARS);
  const [coins, setCoins] = useState(12);
  const [messages, setMessages] =
    useState<Record<string, Message[]>>(DUMMY_MESSAGES);

  const addAvatar = (avatar: Avatar) => {
    setAvatars((prev) => [avatar, ...prev]);
  };

  const removeAvatar = (id: string) => {
    setAvatars((prev) => prev.filter((a) => a.id !== id));
  };

  const addMessage = (avatarId: string, msg: Message) => {
    setMessages((prev) => ({
      ...prev,
      [avatarId]: [...(prev[avatarId] ?? []), msg],
    }));
  };

  const addCoins = (amount: number) => {
    setCoins((prev) => prev + amount);
  };

  const spendCoin = (): boolean => {
    if (coins <= 0) return false;
    setCoins((prev) => prev - 1);
    return true;
  };

  const DUMMY_RESPONSES = [
    "That's a great point! I completely agree with you.",
    "Hmm, let me think about that... I think the key is to stay curious and keep exploring.",
    "You know what? I've been thinking the same thing lately.",
    "That reminds me of something fascinating—the more you learn, the more questions arise!",
    "Absolutely! Life is all about those little moments of connection.",
    "I love that question! The honest answer is: it depends entirely on perspective.",
    "You're onto something really interesting there. Tell me more?",
    "Ha! I wasn't expecting that, but I love it. You always keep me on my toes.",
  ];

  const sendMessage = async (avatarId: string, text: string) => {
    addMessage(avatarId, { role: "user", text });
    // Simulate streaming delay
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
    const response =
      DUMMY_RESPONSES[Math.floor(Math.random() * DUMMY_RESPONSES.length)];
    addMessage(avatarId, { role: "avatar", text: response });
    // Update avatar message count
    setAvatars((prev) =>
      prev.map((a) =>
        a.id === avatarId
          ? { ...a, messageCount: a.messageCount + 1, lastChatAt: new Date() }
          : a,
      ),
    );
  };

  return (
    <AvatarContext.Provider
      value={{
        avatars,
        coins,
        messages,
        addAvatar,
        removeAvatar,
        addMessage,
        addCoins,
        spendCoin,
        sendMessage,
      }}
    >
      {children}
    </AvatarContext.Provider>
  );
}

export function useAvatars() {
  const ctx = useContext(AvatarContext);
  if (!ctx) throw new Error("useAvatars must be used inside AvatarProvider");
  return ctx;
}
