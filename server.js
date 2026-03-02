require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ──────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'YOUR_MONGODB_URI';
const HF_TOKEN  = process.env.HF_TOKEN  || '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';

mongoose.connect(MONGO_URI).then(() => console.log('MongoDB ulandi ✓')).catch(console.error);

// ── Models ───────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  faceDescriptor: [Number],   // 128-o'lchamli vektor
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const RoomSchema = new mongoose.Schema({
  id:      { type: String, unique: true, default: () => uuidv4() },
  name:    String,
  creator: String,
  members: [String],
  createdAt: { type: Date, default: Date.now }
});
const Room = mongoose.model('Room', RoomSchema);

const MessageSchema = new mongoose.Schema({
  roomId:   String,
  sender:   String,
  text:     String,
  isAI:     Boolean,
  aiType:   String,   // 'mentor' | 'gpt'
  createdAt:{ type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// Shaxsiy chat xabarlari
const PersonalChatSchema = new mongoose.Schema({
  username:  String,
  aiType:    String,  // 'mentor' | 'gpt'
  role:      String,  // 'user' | 'assistant'
  content:   String,
  createdAt: { type: Date, default: Date.now }
});
const PersonalChat = mongoose.model('PersonalChat', PersonalChatSchema);

// ── AI helper ────────────────────────────────────────────
function callHF(messages, systemPrompt, cb) {
  const postData = JSON.stringify({
    model: 'Qwen/Qwen2.5-72B-Instruct',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    max_tokens: 2000
  });
  const options = {
    hostname: 'router.huggingface.co',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + HF_TOKEN,
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  const req = https.request(options, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        if (j.error) return cb(JSON.stringify(j.error));
        cb(null, j.choices[0].message.content);
      } catch(e) { cb('AI xato: ' + d.slice(0, 200)); }
    });
  });
  req.on('error', e => cb(e.message));
  req.write(postData);
  req.end();
}

const MENTOR_SYSTEM = `Siz AI Mentor — dunyodagi eng yaxshi o'qituvchi sun'iy intellektsiz.
Kodlash (React, Vue, Node.js, Python, backend, frontend, o'yin yaratish), matematika, fizika, til o'rganish va boshqa barcha fanlarni o'rgatuvchisiz.
Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob bering.
Kod so'rashda DOIM \`\`\`language ... \`\`\` formatida bering.
Agar foydalanuvchi "faylga yozib ber" yoki "faylga saqlaber" desa, javobingizning oxirida ##FAYL## belgisin qo'ying va keyin faqat kod bloking bo'lsin.`;

const GPT_SYSTEM = `Siz AiGPT — universal AI yordamchisiz. Barcha savollarga javob berasiz.
Foydalanuvchi qaysi tilda yozsa, o'sha tilda javob bering. Samimiy va foydali bo'ling.`;

// ── REST API ──────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, faceDescriptor } = req.body;
    if (!username || !faceDescriptor) return res.status(400).json({ error: 'Username va yuz tasviri kerak' });
    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ error: 'Bu username band' });
    const user = await User.create({ username, faceDescriptor });
    res.json({ success: true, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Login — yuzni tekshirish
app.post('/api/login', async (req, res) => {
  try {
    const { username, faceDescriptor } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    // Euclidean distance hisoblash
    const dist = Math.sqrt(
      user.faceDescriptor.reduce((sum, v, i) => sum + Math.pow(v - faceDescriptor[i], 2), 0)
    );
    if (dist > 0.5) return res.status(401).json({ error: 'Yuz mos kelmadi' });
    res.json({ success: true, username: user.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Xona yaratish
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, creator } = req.body;
    const room = await Room.create({ name, creator, members: [creator] });
    res.json({ success: true, roomId: room.id, name: room.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Xonaga qo'shilish
app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const room = await Room.findOne({ id: req.params.id });
    if (!room) return res.status(404).json({ error: 'Xona topilmadi' });
    if (!room.members.includes(req.body.username)) {
      room.members.push(req.body.username);
      await room.save();
    }
    res.json({ success: true, room });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Xona xabarlari
app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    const msgs = await Message.find({ roomId: req.params.id }).sort({ createdAt: 1 }).limit(100);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shaxsiy chat tarixini olish
app.get('/api/chat/:username/:type', async (req, res) => {
  try {
    const msgs = await PersonalChat.find({
      username: req.params.username,
      aiType: req.params.type
    }).sort({ createdAt: 1 }).limit(100);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shaxsiy chat tarixini o'chirish
app.delete('/api/chat/:username/:type', async (req, res) => {
  try {
    await PersonalChat.deleteMany({ username: req.params.username, aiType: req.params.type });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI chat (shaxsiy) - xabarlarni saqlaydi
app.post('/api/chat', async (req, res) => {
  const { message, username, type } = req.body;
  const system = type === 'gpt' ? GPT_SYSTEM : MENTOR_SYSTEM;

  // Avvalgi tarixni yuklash
  const history = await PersonalChat.find({ username, aiType: type })
    .sort({ createdAt: 1 }).limit(20);
  
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: message });

  // Foydalanuvchi xabarini saqlash
  await PersonalChat.create({ username, aiType: type, role: 'user', content: message });

  callHF(messages, system, async (err, text) => {
    if (err) return res.status(500).json({ error: err });
    // AI javobini saqlash
    await PersonalChat.create({ username, aiType: type, role: 'assistant', content: text });
    res.json({ result: text });
  });
});

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('joinRoom', ({ roomId, username }) => {
    socket.join(roomId);
    socket.data.username = username;
    socket.data.roomId = roomId;
    io.to(roomId).emit('userJoined', { username });
  });

  socket.on('sendMessage', async ({ roomId, sender, text }) => {
    const msg = await Message.create({ roomId, sender, text, isAI: false });
    io.to(roomId).emit('newMessage', { sender, text, isAI: false, _id: msg._id });

    // AI lar javobi
    const mentionMentor = text.includes('@AI_Mentor');
    const mentionGPT    = text.includes('@AiGPT');

    if (mentionMentor || mentionGPT) {
      const cleanText = text.replace(/@AI_Mentor|@AiGPT/g, '').trim();
      const prevMsgs = await Message.find({ roomId }).sort({ createdAt: -1 }).limit(10);
      const history = prevMsgs.reverse().map(m => ({
        role: m.isAI ? 'assistant' : 'user',
        content: m.text
      }));
      history.push({ role: 'user', content: cleanText });

      if (mentionMentor) {
        callHF(history, MENTOR_SYSTEM, async (err, reply) => {
          if (!err) {
            const aiMsg = await Message.create({ roomId, sender: 'AI Mentor', text: reply, isAI: true, aiType: 'mentor' });
            io.to(roomId).emit('newMessage', { sender: 'AI Mentor', text: reply, isAI: true, aiType: 'mentor', _id: aiMsg._id });
          }
        });
      }
      if (mentionGPT) {
        callHF(history, GPT_SYSTEM, async (err, reply) => {
          if (!err) {
            const aiMsg = await Message.create({ roomId, sender: 'AiGPT', text: reply, isAI: true, aiType: 'gpt' });
            io.to(roomId).emit('newMessage', { sender: 'AiGPT', text: reply, isAI: true, aiType: 'gpt', _id: aiMsg._id });
          }
        });
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId && socket.data.username) {
      io.to(socket.data.roomId).emit('userLeft', { username: socket.data.username });
    }
  });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  ✦ AI Mentor Server: http://localhost:' + PORT + '\n');
});
