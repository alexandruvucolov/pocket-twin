import { Avatar, ChatMessage } from "../types/avatar";

export const DUMMY_AVATARS: Avatar[] = [
  {
    id: "1",
    name: "Alex Twin",
    imageUri: "https://randomuser.me/api/portraits/men/32.jpg",
    createdAt: new Date("2026-03-01"),
    lastChatAt: new Date("2026-03-11"),
    messageCount: 24,
  },
  {
    id: "2",
    name: "Sofia Twin",
    imageUri: "https://randomuser.me/api/portraits/women/44.jpg",
    createdAt: new Date("2026-03-05"),
    lastChatAt: new Date("2026-03-10"),
    messageCount: 8,
  },
  {
    id: "3",
    name: "Jordan Twin",
    imageUri: "https://randomuser.me/api/portraits/men/76.jpg",
    createdAt: new Date("2026-03-09"),
    messageCount: 0,
  },
];

export const DUMMY_MESSAGES: Record<string, ChatMessage[]> = {
  "1": [
    { role: "avatar", text: "Hey! I'm your Pocket Twin. What's on your mind?" },
    { role: "user", text: "Tell me something interesting." },
    {
      role: "avatar",
      text: "Did you know that honey never expires? Archaeologists found 3000-year-old honey in Egyptian tombs that was still perfectly edible! 🍯",
    },
    { role: "user", text: "Wow, that is amazing!" },
    {
      role: "avatar",
      text: "Right? Nature is wild. Ask me anything else—I've got all day!",
    },
  ],
  "2": [
    { role: "avatar", text: "Hi there! I'm Sofia Twin. Ready to chat? ✨" },
    { role: "user", text: "What should I cook tonight?" },
    {
      role: "avatar",
      text: "How about a creamy pasta with garlic and parmesan? Quick, simple, and absolutely delicious. Want the full recipe?",
    },
  ],
  "3": [],
};

export const COIN_COSTS = {
  // Chat
  avatarReply: 5,
  // Image generation
  textToImage: 1,
  imageToImage: 1,
  // Video generation — text-to-video (PixVerse C1)
  t2v_5s: 14,
  t2v_10s: 25,
  t2v_15s: 38,
  // Video generation — image-to-video (Kling 1.6)
  i2v_5s: 14,
  i2v_10s: 28,
} as const;

export const COIN_PACKS = [
  {
    id: "coins_100",
    label: "100 Coins",
    price: "$5.99",
    coins: 100,
    popular: false,
    bonus: 0,
  },
  {
    id: "coins_200",
    label: "200 Coins",
    price: "$11.99",
    coins: 200,
    popular: true,
    bonus: 50,
  },
  {
    id: "coins_500",
    label: "500 Coins",
    price: "$29.99",
    coins: 500,
    popular: false,
    bonus: 250,
  },
];
