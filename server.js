const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Game State ────────────────────────────────────────────────────────────────
let players = [];       // { id, name, color, hand: [] }
let clickOrder = [];    // socket ids in reaction order
let currentTurnIndex = 0;
let gameActive = false;
let claimMade = false;
let roundResultsSent = false;
let totalPassCount = 0; // only pass #0 allows 4-card starter move

// ─── Deck ──────────────────────────────────────────────────────────────────────
function buildDeck() {
  const suits = ["A", "B", "C", "D"];
  const deck = [];
  suits.forEach((s) => { for (let i = 0; i < 4; i++) deck.push(s); });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function resetGame() {
  players.forEach((p) => { p.hand = []; });
  clickOrder = [];
  currentTurnIndex = 0;
  totalPassCount = 0;
  gameActive = false;
  claimMade = false;
  roundResultsSent = false;
}

function startGame() {
  const deck = shuffle(buildDeck());
  players.forEach((p, i) => {
    p.hand = deck.slice(i * 4, i * 4 + 4);
  });
  currentTurnIndex = 0;
  totalPassCount = 0;
  gameActive = true;
  claimMade = false;
  roundResultsSent = false;
  clickOrder = [];

  io.emit("gameStart", {
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      playerIndex: i,
    })),
    hands: Object.fromEntries(players.map((p) => [p.id, p.hand])),
    currentTurnIndex: 0,
    starterIndex: 0,
  });

  players.forEach(p => {
    if (p.isBot && checkWin(p)) {
      setTimeout(() => triggerBotClaim(p.id), 1500);
    }
  });

  if (players[currentTurnIndex].isBot) {
      triggerBotTurn();
  }
}

function broadcastHandSizes() {
  const sizes = Object.fromEntries(players.map((p) => [p.id, p.hand.length]));
  io.emit("handSizes", sizes);
}

function checkWin(player) {
  if (player.hand.length === 4 && new Set(player.hand).size === 1) {
    return true;
  }
  return false;
}

function triggerBotTurn() {
  if (!gameActive || claimMade) return;
  const botIndex = currentTurnIndex;
  const bot = players[botIndex];
  if (!bot || !bot.isBot) return;

  const delay = Math.floor(Math.random() * 1000) + 1500;
  setTimeout(() => {
    if (!gameActive || claimMade || currentTurnIndex !== botIndex) return;

    const requiredHandSize = botIndex === 0 ? 4 : 5;
    if (bot.hand.length !== requiredHandSize) return;

    const counts = {};
    bot.hand.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
    let cardToPass = bot.hand[0];
    let minFreq = 5;
    bot.hand.forEach(c => {
      if (counts[c] < minFreq) {
        minFreq = counts[c];
        cardToPass = c;
      }
    });

    executePass(botIndex, cardToPass);
  }, delay);
}

function triggerBotClaim(botId) {
  if (!gameActive || claimMade) return;
  const winner = players.find(p => p.id === botId);
  if (!winner || !checkWin(winner)) return;

  claimMade = true;
  gameActive = false;
  clickOrder = [botId];

  console.log(`[★] Claim by bot ${winner.name}`);

  io.emit("reactionPhase", {
    winnerId: botId,
    winnerName: winner.name,
    winnerIndex: players.findIndex((p) => p.id === botId),
  });

  triggerBotReactions();
}

function triggerBotReactions() {
  players.forEach(p => {
    if (p.isBot && !clickOrder.includes(p.id)) {
      const delay = Math.floor(Math.random() * 2500) + 500;
      setTimeout(() => {
        if (!claimMade || clickOrder.includes(p.id)) return;
        clickOrder.push(p.id);
        io.emit("touchUpdate", { clickOrder: [...clickOrder] });
        if (clickOrder.length === 4 && !roundResultsSent) {
          roundResultsSent = true;
          sendRoundResults();
        }
      }, delay);
    }
  });
}

function executePass(senderIndex, card) {
  if (!gameActive || claimMade) return;
  const sender = players[senderIndex];
  if (senderIndex !== currentTurnIndex) return;

  const requiredHandSize = senderIndex === 0 ? 4 : 5;
  if (sender.hand.length !== requiredHandSize) return;

  const cardIdx = sender.hand.indexOf(card);
  if (cardIdx === -1) return;

  sender.hand.splice(cardIdx, 1);
  const nextIndex = (senderIndex + 1) % 4;
  const receiver = players[nextIndex];
  receiver.hand.push(card);

  currentTurnIndex = nextIndex;
  const loopCompleted = senderIndex === 3 && nextIndex === 0;

  io.emit("cardPassed", {
    from: sender.id,
    to: receiver.id,
    fromIndex: senderIndex,
    toIndex: nextIndex,
    card,
    newCurrentTurnIndex: nextIndex,
    loopCompleted,
  });

  players.forEach((p) => {
    if (!p.isBot) io.to(p.id).emit("handUpdate", { hand: p.hand });
  });

  broadcastHandSizes();

  if (checkWin(receiver)) {
    console.log(`[★] ${receiver.name} wins!`);
    if (receiver.isBot) {
       setTimeout(() => triggerBotClaim(receiver.id), 1500);
    }
  }

  if (players[currentTurnIndex].isBot) {
     triggerBotTurn();
  }
}

// ─── Socket Events ─────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Send current lobby state to newly connected client
  socket.emit("lobbyState", {
    count: players.length,
    players: players.map((p) => ({ name: p.name, color: p.color })),
  });

  // ── joinLobby ──────────────────────────────────────────────────────────────
  socket.on("joinLobby", ({ name, color }) => {
    if (players.length >= 4 || gameActive) {
      socket.emit("joinError", "Game is full or already in progress.");
      return;
    }

    // Prevent duplicate names
    if (players.find((p) => p.name === name)) {
      socket.emit("joinError", "Name already taken.");
      return;
    }

    const player = { id: socket.id, name, color, hand: [] };
    players.push(player);

    console.log(`[~] ${name} joined (${players.length}/4)`);

    io.emit("lobbyUpdate", {
      count: players.length,
      players: players.map((p) => ({ name: p.name, color: p.color })),
    });

    socket.emit("joinedLobby", { playerIndex: players.length - 1 });

    if (players.length === 4) {
      setTimeout(startGame, 800);
    }
  });

  // ── startWithBots ────────────────────────────────────────────────────────
  socket.on("startWithBots", () => {
    if (players.length >= 4 || gameActive) return;
    
    const botNames = ["RoboChitti", "Sir Bot-a-Lot", "ByteMaster", "Bot Alpha", "CardShark AI"];
    const botColors = ["#7f8c8d", "#95a5a6", "#bdc3c7", "#34495e"];
    
    while (players.length < 4) {
      const bName = botNames[players.length] || `Bot ${players.length}`;
      const bColor = botColors[players.length % botColors.length];
      players.push({
        id: `bot-${players.length}`,
        name: bName,
        color: bColor,
        isBot: true,
        hand: []
      });
    }
    
    io.emit("lobbyUpdate", {
      count: players.length,
      players: players.map((p) => ({ name: p.name, color: p.color })),
    });

    if (players.length === 4) {
      setTimeout(startGame, 800);
    }
  });

  // ── passToNext ─────────────────────────────────────────────────────────────
  socket.on("passToNext", ({ card }) => {
    if (!gameActive || claimMade) return;

    const senderIndex = players.findIndex((p) => p.id === socket.id);
    if (senderIndex === -1 || senderIndex !== currentTurnIndex) {
      socket.emit("passError", "Not your turn.");
      return;
    }

    const sender = players[senderIndex];
    const requiredHandSize = senderIndex === 0 ? 4 : 5;
    if (sender.hand.length !== requiredHandSize) {
      socket.emit("passError", `Must have ${requiredHandSize} cards to pass.`);
      return;
    }

    const cardIdx = sender.hand.indexOf(card);
    if (cardIdx === -1) {
      socket.emit("passError", "Card not in hand.");
      return;
    }

    executePass(senderIndex, card);
  });

  // ── claim ──────────────────────────────────────────────────────────────────
  socket.on("claim", () => {
    if (!gameActive || claimMade) return;

    const winner = players.find((p) => p.id === socket.id);
    if (!winner) return;

    // Verify legitimacy
    if (!checkWin(winner)) {
      socket.emit("claimError", "Invalid claim.");
      return;
    }

    claimMade = true;
    gameActive = false;
    clickOrder = [socket.id]; // winner is automatically first

    console.log(`[★] Claim by ${winner.name}`);

    io.emit("reactionPhase", {
      winnerId: socket.id,
      winnerName: winner.name,
      winnerIndex: players.findIndex((p) => p.id === socket.id),
    });

    triggerBotReactions();
  });

  // ── touch ──────────────────────────────────────────────────────────────────
  socket.on("touch", () => {
    if (!claimMade) return;
    if (clickOrder.includes(socket.id)) return; // already touched

    clickOrder.push(socket.id);
    io.emit("touchUpdate", { clickOrder: [...clickOrder] });

    if (clickOrder.length === 4 && !roundResultsSent) {
      roundResultsSent = true;
      sendRoundResults();
    }
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const idx = players.findIndex((p) => p.id === socket.id);
    if (idx !== -1) {
      console.log(`[~] ${players[idx].name} left`);
      players.splice(idx, 1);

      if (gameActive || claimMade) {
        // Game disrupted – reset
        io.emit("gameAborted", { reason: "A player disconnected. Returning to lobby." });
        resetGame();
      } else {
        io.emit("lobbyUpdate", {
          count: players.length,
          players: players.map((p) => ({ name: p.name, color: p.color })),
        });
      }
    }
  });
});

// ─── Round Results ─────────────────────────────────────────────────────────────
function sendRoundResults() {
  const pointMap = [1000, 500, 250, 0];
  const results = clickOrder.map((id, rank) => {
    const p = players.find((pl) => pl.id === id);
    return {
      id,
      name: p ? p.name : "?",
      color: p ? p.color : "#fff",
      rank: rank + 1,
      points: pointMap[rank] ?? 0,
    };
  });

  // Handle case where someone never touched (shouldn't happen normally)
  players.forEach((p) => {
    if (!clickOrder.includes(p.id)) {
      results.push({ id: p.id, name: p.name, color: p.color, rank: 4, points: 0 });
    }
  });

  io.emit("roundResults", { results });

  console.log("[~] Round over. Resetting in 8s.");
  setTimeout(() => {
    resetGame();
    io.emit("returnToLobby", {});
    // Re-broadcast updated (empty) lobby
    io.emit("lobbyUpdate", {
      count: players.length,
      players: players.map((p) => ({ name: p.name, color: p.color })),
    });
  }, 8000);
}

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🃏  Char Chitti Pro server running at http://localhost:${PORT}\n`);
});
