export interface Avatar {
  id: string;
  name: string;
  imageUri: string;
  createdAt: Date;
  lastChatAt?: Date;
  messageCount: number;
}

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

export const DUMMY_MESSAGES: Record<
  string,
  { role: "user" | "avatar"; text: string }[]
> = {
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

export const COIN_PACKS = [
  {
    id: "coins_10",
    label: "10 Coins",
    price: "$1.99",
    coins: 10,
    popular: false,
    bonus: 0,
  },
  {
    id: "coins_50",
    label: "50 Coins",
    price: "$7.99",
    coins: 50,
    popular: true,
    bonus: 5,
  },
  {
    id: "coins_100",
    label: "100 Coins",
    price: "$14.99",
    coins: 100,
    popular: false,
    bonus: 15,
  },
];
