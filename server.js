const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const session = require('express-session');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  credentials: true
}));

// --- КОНФИГУРАЦИЯ ---
const STEAM_API_KEY = '53F8644F8ADFF075F3ABFB20E3156983';
const SESSION_SECRET = 'dbd_mmr_secret_key_123'; // В идеале сменить на случайную строку
const PORT = process.env.PORT || 5000;

// 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ
mongoose.connect('mongodb+srv://retroace555_db_user:yPPqobg76LKrufjs@dbdmmr.9c5bmhf.mongodb.net/dbd_mmr')
  .then(() => console.log('✅ Облачная база данных MongoDB Atlas подключена'))
  .catch(err => console.error('❌ Ошибка подключения к Atlas:', err));

// 2. СХЕМЫ ДАННЫХ
const UserSchema = new mongoose.Schema({
  steamId: { type: String, unique: true, required: true },
  nickname: String,
  survivorMMR: { type: Number, default: 1000 },
  killerMMR: { type: Number, default: 1000 },
  lastUpdate: { type: Date, default: Date.now },
  behaviorToken: String // Теперь храним токен здесь для авто-обновления
});

const MatchSchema = new mongoose.Schema({
  steamId: String,
  matchId: { type: String, unique: true },
  role: String,
  mmrChange: Number,
  date: Date
});

const User = mongoose.model('User', UserSchema);
const Match = mongoose.model('Match', MatchSchema);

// 3. НАСТРОЙКА STEAM AUTH (Passport.js)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new SteamStrategy({
    returnURL: 'https://dbd-mmr.onrender.com/auth/steam/return',
    realm: 'https://dbd-mmr.onrender.com/',
    apiKey: STEAM_API_KEY
  },
  async (identifier, profile, done) => {
    try {
      const steamId = profile.id;
      let user = await User.findOne({ steamId });
      if (!user) {
        user = new User({
          steamId,
          nickname: profile.displayName
        });
        await user.save();
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// 4. ЛОГИКА РАСЧЕТА MMR
const MMR_CONFIG = {
  survivor: { escape: 20, death: -20 },
  killer: { kills4: 25, kills3: 10, kills2: 0, kills1: -15, kills0: -25 }
};

function calculateChange(match) {
  const p = match.playerStat || {};
  if (p.killerMatchStatus) {
    const kills = p.killerMatchStatus.kills || 0;
    if (kills >= 4) return MMR_CONFIG.killer.kills4;
    if (kills === 3) return MMR_CONFIG.killer.kills3;
    if (kills === 2) return MMR_CONFIG.killer.kills2;
    if (kills === 1) return MMR_CONFIG.killer.kills1;
    return MMR_CONFIG.killer.kills0;
  } else {
    const status = p.playerStatus?.id || '';
    return status.includes('ESCAPED') ? MMR_CONFIG.survivor.escape : MMR_CONFIG.survivor.death;
  }
}

// 5. ЭНДПОИНТЫ

// Раздача статических файлов из корня
app.use(express.static(__dirname));

// Все остальные запросы, которые не попали в API, отправляют index.html (для SPA)
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Авторизация Steam
app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
  res.redirect('https://dbd-mmr.onrender.com'); // Перенаправляем на основной домен
});

// Выход
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('https://dbd-mmr.onrender.com');
  });
});

// Обновление MMR (теперь может использовать сохраненный токен)
app.post('/api/user/update', async (req, res) => {
  // Если пользователь залогинен через Steam, берем его из сессии
  const user = req.user || await User.findOne({ steamId: req.body.steamId });
  const rawToken = req.body.token || user?.behaviorToken || '';
  const token = String(rawToken).trim().replace(/^Bearer\s+/i, '');

  if (!token) return res.status(400).json({ error: 'Требуется токен Behavior' });

  try {
    if (user) {
        user.behaviorToken = token;
        await user.save();
    }

    const API_URL = 'https://account-backend.bhvr.com/player-stats/match-history/games/dbd/providers/bhvr?lang=en&limit=100';
    const response = await axios.get(API_URL, {
      headers: { 'authorization': `Bearer ${token}`, 'Referer': 'https://stats.deadbydaylight.com/' }
    });

    const matches = response.data;
    let totalSurvChange = 0;
    let totalKillChange = 0;

    for (const match of matches) {
      const matchId = match.id || JSON.stringify(match);
      const alreadyProcessed = await Match.findOne({ matchId });
      if (!alreadyProcessed) {
        const change = calculateChange(match);
        const isKiller = !!match.playerStat?.killerMatchStatus;
        if (isKiller) totalKillChange += change;
        else totalSurvChange += change;
        await Match.create({
            steamId: user?.steamId || req.body.steamId,
            matchId,
            role: isKiller ? 'killer' : 'survivor',
            mmrChange: change,
            date: new Date()
        });
      }
    }

    if (user) {
        user.survivorMMR += totalSurvChange;
        user.killerMMR += totalKillChange;
        user.lastUpdate = new Date();
        await user.save();
    }

    res.json({ message: 'MMR обновлен', survivorMMR: user?.survivorMMR, killerMMR: user?.killerMMR });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления данных.' });
  }
});

app.get('/api/leaderboard/:role', async (req, res) => {
  const { role } = req.params;
  const field = role === 'survivor' ? 'survivorMMR' : 'killerMMR';
  try {
    const topPlayers = await User.find().sort({ [field]: -1 }).limit(100);
    res.json(topPlayers);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Текущий пользователь (для фронтенда)
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  res.json(req.user);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
    const filePath = path.join(__dirname, 'index.html');
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Ошибка отправки файла:', filePath, err);
        res.status(404).send('Файл index.html не найден в корне сервера');
      }
    });
  } else {
    next();
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер с поддержкой Steam запущен на порту ${PORT}`));
